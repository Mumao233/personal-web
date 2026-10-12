"""HTTP integration checks for Earth services, with no outbound network.

Uses a temporary project, genuine bundled ocean/current fixtures, a test-only
terrain PNG, mocked refresh entrypoints, and blocked upstream network clients.
Run: python -B -m unittest test_earth_services_server -v
"""
from contextlib import ExitStack
import hashlib
import http.client
import json
from pathlib import Path
import shutil
import struct
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import zlib

import server
from currents_service import CurrentsService
from ocean_services import OceanServices, PRODUCTS
from terrain_service import TerrainService, validate_png


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


def terrain_fixture():
    """A clearly isolated test PNG; never copied into deliverable data."""
    def chunk(kind, value):
        return (struct.pack('>I', len(value)) + kind + value
                + struct.pack('>I', zlib.crc32(kind + value) & 0xffffffff))
    pixels = (b'\0' + b'\x80\0\0' * 256) * 256
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


class EarthServicesServerChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_root = server.ROOT
        cls.temporary = tempfile.TemporaryDirectory(prefix='atlas-earth-http-check-')
        cls.root = Path(cls.temporary.name).resolve()
        shutil.copytree(cls.original_root / 'data/ocean', cls.root / 'data/ocean')
        shutil.copytree(cls.original_root / 'data/services-current', cls.root / 'data/services-current')
        (cls.root / 'index.html').write_text('<!doctype html><title>Earth HTTP test fixture</title>', encoding='utf-8')
        cls.terrain_png = terrain_fixture()
        validate_png(cls.terrain_png)
        tile = cls.root / '.runtime/terrain/2/1/1.png'
        tile.parent.mkdir(parents=True)
        tile.write_bytes(cls.terrain_png)
        cls.patches = ExitStack()
        cls.network_clients = [
            cls.patches.enter_context(patch(target, side_effect=AssertionError('Outbound network forbidden in HTTP tests')))
            for target in ('ocean_services.build_opener', 'currents_service.urlopen', 'terrain_service.urlopen')
        ]
        server.ROOT = cls.root
        cls.httpd = server.LocalServer(('127.0.0.1', 0), QuietHandler)
        cls.httpd._ocean = OceanServices(cls.root)
        cls.httpd._currents = CurrentsService(cls.root)
        cls.httpd._terrain = TerrainService(cls.root)
        cls.httpd._ocean.refresh = Mock(return_value=cls.httpd._ocean.status())
        cls.httpd._currents.refresh = Mock(return_value=cls.httpd._currents.status())
        cls.httpd._terrain._check_robots = Mock(side_effect=OSError('Network disabled by test fixture'))
        cls.httpd._terrain.tile_path = Mock(wraps=cls.httpd._terrain.tile_path)
        cls.port = cls.httpd.server_port
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)
        cls.patches.close()
        server.ROOT = cls.original_root
        cls.temporary.cleanup()

    def setUp(self):
        self.httpd._ocean.refresh.reset_mock()
        self.httpd._currents.refresh.reset_mock()
        self.httpd._terrain.tile_path.reset_mock()
        self.httpd._terrain._check_robots.reset_mock()

    def tearDown(self):
        for client in self.network_clients:
            client.assert_not_called()

    def request(self, path, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=4)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_capabilities_advertise_connected_earth_services(self):
        status, _, body = self.request('/__local/status')
        self.assertEqual(status, 200)
        capabilities = json.loads(body)['capabilities']
        for key in ('ocean_imagery', 'terrain', 'reference_layers', 'geostrophic_currents'):
            self.assertTrue(capabilities[key])

    def test_ocean_metadata_and_versioned_images_have_matching_hashes(self):
        for kind in PRODUCTS:
            with self.subTest(product=kind):
                status, headers, body = self.request('/__local/ocean/' + kind + '/metadata?offline=1')
                self.assertEqual(status, 200)
                self.assertIn('application/json', headers['Content-Type'])
                metadata = json.loads(body)
                self.assertTrue(metadata['available'])
                for name in ('image', 'legend'):
                    image_status, image_headers, image = self.request(metadata[name + 'Url'])
                    self.assertEqual(image_status, 200)
                    self.assertEqual(image_headers['Content-Type'], 'image/png')
                    self.assertEqual(hashlib.sha256(image).hexdigest(), metadata[name + 'Sha256'])
        self.httpd._ocean.refresh.assert_not_called()

    def test_ocean_online_metadata_requests_one_bounded_refresh(self):
        self.assertEqual(self.request('/__local/ocean/sst/metadata')[0], 200)
        self.httpd._ocean.refresh.assert_called_once_with('sst')

    def test_ocean_offline_and_head_metadata_do_not_request_upstream(self):
        self.assertEqual(self.request('/__local/ocean/sst/metadata?offline=1')[0], 200)
        status, headers, body = self.request('/__local/ocean/sst/metadata', 'HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertGreater(int(headers['Content-Length']), 0)
        self.httpd._ocean.refresh.assert_not_called()

    def test_unknown_ocean_versions_do_not_return_a_different_image(self):
        for version in ('0' * 16, '../metadata.json', 'https://other.example', 'a' * 64):
            with self.subTest(version=version):
                status, headers, body = self.request('/__local/ocean/sst/image.png?v=' + version)
                self.assertEqual(status, 404)
                self.assertIn('application/json', headers['Content-Type'])
                self.assertIn('error', json.loads(body))
        self.httpd._ocean.refresh.assert_not_called()

    def test_ocean_unknown_products_and_paths_are_honest_404(self):
        for path in ('/__local/ocean/private/metadata', '/__local/ocean/sst/nope.png',
                     '/__local/ocean/sst/../../server.py', '/__local/ocean/refresh'):
            self.assertEqual(self.request(path)[0], 404, path)
        self.httpd._ocean.refresh.assert_not_called()

    def test_ocean_head_image_has_no_body_and_correct_length(self):
        metadata = self.httpd._ocean.metadata('sst', refresh=False)
        status, headers, body = self.request(metadata['imageUrl'], 'HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertEqual(int(headers['Content-Length']), (self.root / 'data/ocean/sst/image.png').stat().st_size)

    def test_currents_manifest_and_oacf_binary_match_sha_and_dimensions(self):
        status, headers, body = self.request('/__local/currents/manifest.json?offline=1')
        self.assertEqual(status, 200)
        self.assertIn('application/json', headers['Content-Type'])
        manifest = json.loads(body)
        self.assertFalse(manifest['simulated'])
        name = manifest['file'].rsplit('/', 1)[-1]
        for path in (manifest['file'], '/__local/currents/files/' + name):
            with self.subTest(path=path):
                asset_status, asset_headers, binary = self.request(path)
                self.assertEqual(asset_status, 200)
                self.assertEqual(hashlib.sha256(binary).hexdigest(), manifest['sha256'])
                self.assertEqual(len(binary), manifest['bytes'])
                magic, version, width, height = struct.unpack_from('<4sHHH', binary)
                self.assertEqual((magic, version, width, height), (b'OACF', 1, manifest['width'], manifest['height']))
        self.httpd._currents.refresh.assert_not_called()

    def test_currents_online_offline_and_head_refresh_contract(self):
        self.request('/__local/currents/manifest.json?offline=1')
        status, headers, body = self.request('/__local/currents/manifest.json', 'HEAD')
        self.assertEqual((status, body), (200, b''))
        self.httpd._currents.refresh.assert_not_called()
        self.assertEqual(self.request('/__local/currents/manifest.json')[0], 200)
        self.httpd._currents.refresh.assert_called_once_with(force=False)

    def test_currents_files_reject_unknown_name_and_traversal(self):
        for name in ('not-currents.oacf', 'aoml-geostrophic-' + '0' * 16 + '.oacf',
                     '../../server.py', '%2e%2e%2fserver.py'):
            self.assertEqual(self.request('/__local/currents/files/' + name)[0], 404)
        self.httpd._currents.refresh.assert_not_called()

    def test_terrain_cached_tile_is_available_without_network(self):
        status, headers, body = self.request('/__local/terrain/2/1/1.png?offline=1')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'image/png')
        self.assertEqual(body, self.terrain_png)
        self.httpd._terrain.tile_path.assert_called_once_with(2, 1, 1, online=False)
        self.httpd._terrain._check_robots.assert_not_called()

    def test_terrain_missing_offline_tile_is_empty_204(self):
        status, headers, body = self.request('/__local/terrain/2/3/3.png?offline=1')
        self.assertEqual((status, body), (204, b''))
        self.assertEqual(headers['Content-Length'], '0')
        self.httpd._terrain.tile_path.assert_called_once_with(2, 3, 3, online=False)
        self.httpd._terrain._check_robots.assert_not_called()

    def test_terrain_head_never_downloads_missing_tile(self):
        status, _, body = self.request('/__local/terrain/2/2/2.png', 'HEAD')
        self.assertEqual((status, body), (204, b''))
        self.httpd._terrain.tile_path.assert_called_once_with(2, 2, 2, online=False)
        self.httpd._terrain._check_robots.assert_not_called()

    def test_terrain_online_source_failure_returns_204_not_fake_height(self):
        status, headers, body = self.request('/__local/terrain/3/7/7.png')
        self.assertEqual((status, body), (204, b''))
        self.assertEqual(headers['Content-Length'], '0')
        self.httpd._terrain.tile_path.assert_called_once_with(3, 7, 7, online=True)
        self.httpd._terrain._check_robots.assert_called_once()

    def test_terrain_coordinate_bounds_and_malformed_paths(self):
        for path in ('16/0/0.png', '1/2/0.png', '1/0/2.png', '0/1/0.png'):
            status, headers, body = self.request('/__local/terrain/' + path + '?offline=1')
            self.assertEqual(status, 400, path)
            self.assertIn('error', json.loads(body))
        for path in ('-1/0/0.png', '1/a/0.png', '1/0/0.jpg', '1/../../server.py'):
            self.assertEqual(self.request('/__local/terrain/' + path)[0], 404, path)
        self.httpd._terrain._check_robots.assert_not_called()

    def test_status_routes_are_read_only(self):
        for name in ('ocean', 'currents', 'terrain'):
            status, headers, body = self.request('/__local/' + name + '/status')
            self.assertEqual(status, 200)
            self.assertIsInstance(json.loads(body), dict)
        self.httpd._ocean.refresh.assert_not_called()
        self.httpd._currents.refresh.assert_not_called()
        self.httpd._terrain._check_robots.assert_not_called()

    def test_cross_origin_refresh_posts_are_rejected_before_service_call(self):
        for name in ('ocean', 'currents'):
            for origin in ('https://other.example', 'null', 'http://127.0.0.1:1'):
                with self.subTest(service=name, origin=origin):
                    self.assertEqual(self.request('/__local/' + name + '/refresh', 'POST', {'Origin': origin})[0], 403)
        self.httpd._ocean.refresh.assert_not_called()
        self.httpd._currents.refresh.assert_not_called()

    def test_local_origin_refresh_posts_use_bounded_force_entrypoint(self):
        for name, service in (('ocean', self.httpd._ocean), ('currents', self.httpd._currents)):
            status, headers, body = self.request('/__local/' + name + '/refresh', 'POST',
                                                 {'Origin': f'http://127.0.0.1:{self.port}'})
            self.assertEqual(status, 200)
            self.assertIsInstance(json.loads(body), dict)
            service.refresh.assert_called_once_with(force=True)


if __name__ == '__main__':
    unittest.main()
