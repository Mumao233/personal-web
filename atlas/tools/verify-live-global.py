"""Verify real cached global weather, units, orientation and failure handling.

python tools/verify-live-global.py [--netcdf captured-source.nc] [--url http://127.0.0.1:8766]
This check never requests the public upstream or substitutes synthetic weather.
"""
from array import array
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from weather_live import ClassicNetCDF, WeatherDataError, WeatherLive, convert_netcdf


def run(args):
    checks = []

    def check(name, result, detail=None):
        checks.append({'name': name, 'passed': bool(result), 'detail': detail})
        if not result:
            raise AssertionError(name)

    service = WeatherLive(ROOT)
    metadata = service.manifest(auto_refresh=False)
    check('A genuine downloaded cache is available', service.cached is not None, metadata['weatherStatus'])
    width, height = metadata['width'], metadata['height']
    check('Original 0.25 degree global resolution preserved', (width, height, metadata['dLon'], metadata['dLat']) == (1440, 721, .25, .25))
    values = []
    for key, expected_size in [('binaryParts', width * height * 12), ('cloudBinaryParts', width * height * 4)]:
        content = bytearray()
        for part in metadata[key]:
            path = service.asset_path(part['url'].rsplit('/', 1)[-1])
            data = path.read_bytes()
            check('Chunk checksum: ' + path.name, hashlib.sha256(data).hexdigest() == part['sha256'] and len(data) == part['bytes'])
            content.extend(data)
        check('Complete grid byte count: ' + key, len(content) == expected_size, len(content))
        grid = array('f')
        grid.frombytes(content)
        if sys.byteorder != 'little':
            grid.byteswap()
        check('Finite values: ' + key, all(math.isfinite(value) for value in grid))
        values.append(grid)
    surface, clouds = values
    check('Cloud percentage converted into fractions', 0 <= min(clouds) <= max(clouds) <= 1, [min(clouds), max(clouds)])
    check('Wind velocity in plausible metres per second', max(abs(value) for c in (0, 1) for value in surface[c::3]) <= 200)
    check('Precipitation rate in nonnegative millimetres per hour', 0 <= min(surface[2::3]) <= max(surface[2::3]) <= 3600,
          [min(surface[2::3]), max(surface[2::3])])
    check('Source times and model run recorded', all(metadata.get(key) for key in ('validTime', 'downloadedAt', 'modelRunTime', 'url', 'upstreamSha256')))
    check('Unsafe chunk names rejected', all(service.asset_path(name) is None for name in ('../manifest.json', '/etc/passwd', 'gfs-surface.bin', 'x.bin')))
    check('Unsupported full grid paths rejected', service.full_grid_path('../state.json') is None)
    check('Empty or HTML upstream cannot become a weather grid', all(reject_bad(content) for content in (b'', b'<!DOCTYPE html>login', b'CDF\x01\x00')))

    if args.netcdf:
        source = Path(args.netcdf).read_bytes()
        dataset = ClassicNetCDF(source)
        converted, raw_surface, raw_cloud = convert_netcdf(source, metadata['downloadedAt'])
        check('Captured upstream forecast time matches cache', converted['validTime'] == metadata['validTime'])
        check('All four fields use their own declared forecast coordinates',
              all(converted['variableValidTimes'][name] == dataset.coordinate_time(name)
                  for name in converted['variableValidTimes']), converted['variableValidTimes'])
        check('Rain and clouds retain their specific valid times',
              converted['rainTime'] == dataset.coordinate_time('Precipitation_rate_surface')
              and converted['cloudTime'] == dataset.coordinate_time('Total_cloud_cover_entire_atmosphere'))
        check('All converted surface samples match saved live data', raw_surface == service.full_grid_path('gfs-surface.bin').read_bytes())
        check('All converted cloud samples match saved live data', raw_cloud == service.full_grid_path('gfs-clouds.bin').read_bytes())
        from weather_live import VARIABLES
        raw_values = [dataset.values(name) for name in VARIABLES]
        source_lat = dataset.values('latitude')
        source_lon = dataset.values('longitude')
        for lon, lat in [(-180, -90), (0, 0), (120, 30), (-75, 40), (179.75, 90)]:
            source_x = list(source_lon).index(lon % 360)
            source_y = list(source_lat).index(lat)
            source_i = source_y * width + source_x
            local_i = round((lat + 90) / .25) * width + round((lon + 180) / .25)
            actual = [surface[local_i * 3 + c] for c in range(3)] + [clouds[local_i]]
            expected = [raw_values[c][source_i] * scale for c, scale in enumerate((1, 1, 3600, .01))]
            check(f'Geographic orientation and unit scaling at {lon},{lat}',
                  all(math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-6) for a, b in zip(actual, expected)),
                  {'actual': actual, 'expected': expected})

    with tempfile.TemporaryDirectory(prefix='atlas-weather-check-') as temporary:
        root = Path(temporary)
        (root / 'weather').mkdir()
        shutil.copyfile(ROOT / 'weather/gfs-surface.json', root / 'weather/gfs-surface.json')
        failed = WeatherLive(root)
        failed.cached = dict(service.cached)
        failed.last_success = service.last_success
        original = json.dumps(failed.cached, sort_keys=True)
        def unavailable():
            raise OSError('Deliberate upstream-offline test')
        failed._download = unavailable
        failed.refresh()
        while failed.status()['refreshing']:
            time.sleep(.01)
        check('Upstream error retains authentic last successful grid', json.dumps(failed.cached, sort_keys=True) == original)
        check('Upstream error is explicitly cached/error state', failed.status()['mode'] == 'cached' and failed.status()['state'] == 'error')
        checked = failed.status()['lastChecked']
        failed.refresh()
        check('Repeated manual refresh respects five minute minimum', failed.status()['lastChecked'] == checked and not failed.status()['refreshing'])
        fresh = WeatherLive(root)
        archived = fresh.manifest(auto_refresh=False)
        check('No-cache offline state retains original archive', archived['weatherStatus']['mode'] == 'archive' and archived['validTime'].startswith('2026-10-03'))

    if args.url:
        opener = build_opener(ProxyHandler({}))
        with opener.open(args.url.rstrip('/') + '/__local/weather/gfs-surface.json?offline=1', timeout=10) as response:
            served = json.load(response)
        check('Local endpoint serves the validated manifest', served['validTime'] == metadata['validTime'])
        for key in ('binaryParts', 'cloudBinaryParts'):
            part = served[key][0]
            with opener.open(args.url.rstrip('/') + part['url'], timeout=10) as response:
                body = response.read()
            check('Local endpoint serves verified chunk ' + key, len(body) == part['bytes'] and hashlib.sha256(body).hexdigest() == part['sha256'])

    return {'checkedAt': datetime.now(timezone.utc).isoformat(), 'passed': len(checks), 'failed': 0,
            'source': metadata['url'], 'validTime': metadata['validTime'],
            'modelRunTime': metadata['modelRunTime'], 'checks': checks}


def reject_bad(content):
    try:
        ClassicNetCDF(content)
        return False
    except (WeatherDataError, ValueError, UnicodeDecodeError):
        return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--netcdf')
    parser.add_argument('--url')
    parser.add_argument('--output')
    arguments = parser.parse_args()
    result = run(arguments)
    if arguments.output:
        Path(arguments.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
