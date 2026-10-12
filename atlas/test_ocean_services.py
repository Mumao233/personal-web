"""Offline validation of the bounded NASA GIBS integration."""
from datetime import date
from pathlib import Path
import hashlib
import json
import shutil
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request
import zlib

import ocean_services
from ocean_services import OceanServices, PRODUCTS, available_dates, validate_png, _ProviderRedirects

ROOT = Path(__file__).resolve().parent


class OceanServicesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        shutil.copytree(ROOT / 'data' / 'ocean', self.root / 'data' / 'ocean')
        self.service = OceanServices(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def test_all_genuine_snapshots_have_data_and_transparent_missing_pixels(self):
        for kind in PRODUCTS:
            metadata = self.service.metadata(kind, refresh=False)
            self.assertTrue(metadata['available'])
            self.assertEqual(metadata['state'], 'snapshot')
            result = validate_png(self.service.asset_file(kind, 'image.png').read_bytes(),
                                  (1024, 512), require_data=True)
            self.assertEqual(result['sha256'], metadata['imageSha256'])
            self.assertGreater(result['transparentPixels'], 0)
            self.assertGreater(result['visiblePixels'], 0)

    def test_source_dates_are_not_replaced_by_today(self):
        metadata = self.service.metadata('salinity', refresh=False)
        self.assertEqual(metadata['validDate'], '2026-10-07')
        self.assertIn('8-day', metadata['aggregationEn'])
        self.assertFalse(metadata['isInstantaneous'])

    def test_capabilities_dates_do_not_invent_gaps_or_future_products(self):
        actual = available_dates('2026-01-01/2026-01-02/P1D,2026-01-06/2026-01-09/P1D',
                                 date(2026, 1, 7))
        self.assertEqual(actual, ['2026-01-07', '2026-01-06', '2026-01-02'])

    def test_html_error_and_wrong_dimensions_are_rejected(self):
        with self.assertRaises(ValueError):
            validate_png(b'<html>Service unavailable</html>')
        with self.assertRaises(ValueError):
            validate_png(self.service.asset_file('sst', 'image.png').read_bytes(), (1, 1))

    def test_corrupt_png_is_rejected(self):
        image = bytearray(self.service.asset_file('sst', 'image.png').read_bytes())
        image[100] ^= 1
        with self.assertRaises(ValueError):
            validate_png(bytes(image))

    def test_unknown_products_and_asset_traversal_are_rejected(self):
        with self.assertRaises(ValueError):
            self.service.metadata('../../secrets')
        self.assertIsNone(self.service.asset_file('sst', '../metadata.json'))
        self.assertIsNone(self.service.asset_file('https://other.example', 'image.png'))
        with self.assertRaises(ValueError):
            self.service._read('https://other.example/image.png')

    def test_network_failure_retains_true_snapshot(self):
        before = self.service.asset_file('sst', 'image.png').read_bytes()
        with patch.object(self.service, '_get_capabilities', side_effect=OSError('offline')):
            self.service._refresh_one('sst')
        result = self.service.metadata('sst', refresh=False)
        self.assertEqual(result['state'], 'snapshot')
        self.assertEqual(result['error'], 'offline')
        self.assertTrue(result['available'])
        self.assertEqual(before, self.service.asset_file('sst', 'image.png').read_bytes())

    def test_latest_existing_date_is_checked_without_redownloading_image(self):
        current = self.service.metadata('sst', refresh=False)['validDate']
        with patch.object(self.service, '_get_capabilities', return_value={'sst': {'dates': [current]}}), \
                patch.object(self.service, '_read') as read:
            self.service._refresh_one('sst')
        read.assert_not_called()
        self.assertEqual(self.service.metadata('sst', refresh=False)['state'], 'live')

    def test_access_denial_does_not_try_other_dates(self):
        advertised = {'sst': {'dates': ['2026-10-12', '2026-10-11']}}
        error = HTTPError('https://gibs.earthdata.nasa.gov/', 403, 'Forbidden', {}, None)
        with patch.object(self.service, '_get_capabilities', return_value=advertised), \
                patch.object(self.service, '_read', side_effect=error) as read:
            self.service._refresh_one('sst')
        self.assertEqual(read.call_count, 1)
        self.assertIn('403', self.service.metadata('sst', refresh=False)['error'])

    def test_repeated_refresh_is_rate_limited(self):
        self.service._attempts['sst'] = time.time()
        with patch('ocean_services.threading.Thread') as thread:
            self.service.refresh('sst', force=True)
            self.service.refresh('sst')
        thread.assert_not_called()

    def _new_image(self, marker):
        # Test-only ancillary metadata changes preserve the actual source pixels.
        original = (self.root / 'data/ocean/sst/image.png').read_bytes()
        kind, payload = b'tEXt', ('test\0' + marker).encode('ascii')
        chunk = struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
        return original[:-12] + chunk + original[-12:]

    def _fixture_read(self, image):
        legend = (self.root / 'data/ocean/sst/legend.png').read_bytes()
        return lambda url, **kwargs: legend if '/legends/' in url else image

    def test_atomic_generation_commit_and_previous_version_keep_matching_hashes(self):
        old = self.service.metadata('sst', refresh=False)
        image = self._new_image('generation-1')
        entered, release = threading.Event(), threading.Event()
        atomic = ocean_services._atomic

        def staged_write(path, content):
            atomic(path, content)
            if path.name == 'image.png':
                entered.set()
                self.assertTrue(release.wait(5))

        with patch.object(self.service, '_get_capabilities', return_value={'sst': {'dates': ['2026-10-12']}}), \
                patch.object(self.service, '_read', side_effect=self._fixture_read(image)), \
                patch('ocean_services._atomic', side_effect=staged_write):
            worker = threading.Thread(target=self.service._refresh_one, args=('sst',))
            worker.start()
            self.assertTrue(entered.wait(5))
            try:
                for _ in range(20):
                    result = self.service.metadata('sst', refresh=False)
                    path = self.service.asset_file('sst', 'image.png', result['imageSha256'][:16])
                    self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), result['imageSha256'])
                    self.assertEqual(result['imageSha256'], old['imageSha256'])
            finally:
                release.set()
            worker.join(5)
            self.assertFalse(worker.is_alive())
        new = self.service.metadata('sst', refresh=False)
        self.assertNotEqual(new['imageSha256'], old['imageSha256'])
        for record in (old, new):
            path = self.service.asset_file('sst', 'image.png', record['imageSha256'][:16])
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), record['imageSha256'])
        reloaded = OceanServices(self.root).metadata('sst', refresh=False)
        self.assertEqual(reloaded['imageSha256'], new['imageSha256'])
        self.assertEqual(reloaded['state'], 'cache')

    def test_interrupted_pointer_commit_preserves_old_generation(self):
        original = self.service.metadata('sst', refresh=False)
        atomic = ocean_services._atomic

        def interrupted_write(path, content):
            if path.name == 'current.json':
                raise OSError('simulated interrupted commit')
            atomic(path, content)

        with patch.object(self.service, '_get_capabilities', return_value={'sst': {'dates': ['2026-10-12']}}), \
                patch.object(self.service, '_read', side_effect=self._fixture_read(self._new_image('interrupted'))), \
                patch('ocean_services._atomic', side_effect=interrupted_write):
            self.service._refresh_one('sst')
        self.assertEqual(self.service.metadata('sst', refresh=False)['imageSha256'], original['imageSha256'])
        self.assertEqual(OceanServices(self.root).metadata('sst', refresh=False)['imageSha256'], original['imageSha256'])

    def test_generation_storage_is_bounded_and_never_removes_bundled_snapshot(self):
        for i in range(6):
            with patch.object(self.service, '_get_capabilities', return_value={'sst': {'dates': ['2026-10-' + str(12 + i)]}}), \
                    patch.object(self.service, '_read', side_effect=self._fixture_read(self._new_image(str(i)))):
                self.service._refresh_one('sst')
            time.sleep(.003)
        product = self.root / '.runtime/ocean/sst'
        generations = [p for p in product.iterdir() if p.is_dir()]
        self.assertLessEqual(len(generations), ocean_services.MAX_GENERATIONS)
        self.assertTrue((self.root / 'data/ocean/sst/image.png').exists())
        self.assertEqual(OceanServices(self.root).metadata('sst', refresh=False)['validDate'], '2026-10-17')

    def test_unknown_version_never_returns_mismatched_latest_image(self):
        self.assertIsNone(self.service.asset_file('sst', 'image.png', '0' * 16))
        self.assertIsNone(self.service.asset_file('sst', 'image.png', '../etc'))

    def test_redirect_to_other_host_is_rejected_before_following(self):
        with self.assertRaises(ValueError):
            _ProviderRedirects().redirect_request(Request('https://gibs.earthdata.nasa.gov/'), None,
                                                  302, 'Found', {}, 'https://other.example/private')

    def test_corrupt_current_pointer_falls_back_to_genuine_snapshot(self):
        folder = self.root / '.runtime/ocean/sst'
        folder.mkdir(parents=True)
        (folder / 'current.json').write_text(json.dumps({'generation': '../../outside'}))
        self.assertEqual(OceanServices(self.root).metadata('sst', refresh=False)['state'], 'snapshot')


if __name__ == '__main__':
    unittest.main()
