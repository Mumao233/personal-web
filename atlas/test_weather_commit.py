"""Offline weather generation tests; only temporary synthetic grids are used."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from weather_live import WeatherLive


class WeatherCommitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='atlas-weather-commit-')
        self.root = Path(self.temp.name)
        self.service = WeatherLive(self.root)
        self.network = patch('weather_live.urlopen', side_effect=AssertionError('Network forbidden'))
        self.urlopen = self.network.start()
        count = 360 * 181
        self.a = (b'A' * (count * 12), b'a' * (count * 4))
        self.b = (b'B' * (count * 12), b'b' * (count * 4))
        self.metadata = {'width': 360, 'height': 181, 'validTime': '2026-10-13T00:00:00Z',
                         'downloadedAt': '2026-10-13T00:00:00Z', 'generation': 'A'}
        self.service._commit(self.metadata, *self.a)

    def tearDown(self):
        self.urlopen.assert_not_called()
        self.network.stop()
        self.temp.cleanup()

    def assert_generation(self, service, label, expected):
        self.assertEqual(service.cached['generation'], label)
        for alias, key, content in [('gfs-surface.bin', 'binary', expected[0]),
                                    ('gfs-clouds.bin', 'cloudBinary', expected[1])]:
            self.assertEqual(service.full_grid_path(alias).read_bytes(), content)
            name = service.cached[key].removeprefix('/__local/weather/')
            self.assertEqual(service.full_grid_path(name).read_bytes(), content)

    def test_failed_grid_or_manifest_write_preserves_generation_after_restart(self):
        # Cover every stage after chunks: either full grid, backup, publication.
        for failure in ('surface', 'clouds', 'previous-manifest.json', 'manifest.json'):
            with self.subTest(stage=failure):
                original = self.service._atomic_write

                def fail(path, content):
                    if ((path.parent.name == 'grids' and path.name.startswith('gfs-' + failure + '-'))
                            or path.name == failure):
                        raise OSError('Synthetic commit failure')
                    return original(path, content)

                # Use different content per stage so each candidate grid is new.
                suffix = bytes([len(failure)])
                candidate = tuple(suffix * len(data) for data in self.b)
                with patch.object(self.service, '_atomic_write', side_effect=fail):
                    with self.assertRaises(OSError):
                        self.service._commit(dict(self.metadata, generation='B'), *candidate)
                self.assert_generation(self.service, 'A', self.a)
                self.assert_generation(WeatherLive(self.root), 'A', self.a)

    def test_success_switches_aliases_and_keeps_previous_immutable_grid(self):
        previous = dict(self.service.cached)
        self.service._commit(dict(self.metadata, generation='B'), *self.b)
        self.assert_generation(self.service, 'B', self.b)
        self.assert_generation(WeatherLive(self.root), 'B', self.b)
        for key, content in [('binary', self.a[0]), ('cloudBinary', self.a[1])]:
            name = previous[key].removeprefix('/__local/weather/')
            self.assertEqual(self.service.full_grid_path(name).read_bytes(), content)

    def test_legacy_manifest_uses_verified_chunks_not_interrupted_mutable_aliases(self):
        legacy = dict(self.service.cached, binary='/__local/weather/gfs-surface.bin',
                      cloudBinary='/__local/weather/gfs-clouds.bin')
        (self.service.cache / 'manifest.json').write_text(json.dumps(legacy), encoding='utf-8')
        for alias, content in zip(('gfs-surface.bin', 'gfs-clouds.bin'), self.b):
            (self.service.cache / alias).write_bytes(content)
        for path in (self.service.cache / 'grids').glob('*.bin'):
            path.unlink()
        restarted = WeatherLive(self.root)
        self.assert_generation(restarted, 'A', self.a)
        self.assertIn('/grids/', restarted.manifest(auto_refresh=False)['binary'])

    def test_derived_grid_is_repaired_from_verified_chunks(self):
        self.service.full_grid_path('gfs-surface.bin').write_bytes(b'broken')
        self.assert_generation(WeatherLive(self.root), 'A', self.a)

    def test_corrupt_chunks_are_not_accepted(self):
        name = self.service.cached['binaryParts'][0]['url'].rsplit('/', 1)[-1]
        self.service.asset_path(name).write_bytes(b'broken')
        restarted = WeatherLive(self.root)
        self.assertIsNone(restarted.cached)
        self.assertIsNone(restarted.full_grid_path('gfs-surface.bin'))

    def test_grid_paths_cannot_escape_cache(self):
        for name in ('../manifest.json', 'grids/../manifest.json', 'gfs-surface.bin/extra',
                     'grids/gfs-surface-' + '0' * 64 + '.bin', None):
            self.assertIsNone(self.service.full_grid_path(name))


if __name__ == '__main__':
    unittest.main()
