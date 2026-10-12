"""NOAA/AOML near-real-time geostrophic currents for the original OACF renderer.

This is satellite-derived geostrophic flow, not total currents or an observation
at the user's present instant. Source gaps and the polar regions stay masked.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import threading
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser

SOURCE = 'NOAA / AOML · Near Real Time Geostrophic Currents'
SOURCE_PAGE = 'https://cwcgom.aoml.noaa.gov/erddap/info/miamicurrents/index.html'
QUERY = 'u_current[(last)][0:5:647][0:5:1799],v_current[(last)][0:5:647][0:5:1799]'
SOURCE_URL = 'https://cwcgom.aoml.noaa.gov/erddap/griddap/miamicurrents.json?' + quote(QUERY, safe=',:')
USER_AGENT = 'SolarSystemAtlasLocal/4.0 (public ocean data client)'
REFRESH_SECONDS = 6 * 3600
MIN_REFRESH_SECONDS = 15 * 60
MAX_BYTES = 10 * 1024 * 1024
ASSET_PATTERN = re.compile(r'aoml-geostrophic-[a-f0-9]{16}\.oacf\Z')


def iso(value=None):
    return datetime.fromtimestamp(value if value is not None else time.time(), timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def seconds(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def convert_response(content, downloaded_at=None):
    """Validate ERDDAP's rectangular table and make a 1-degree OACF field."""
    response = json.loads(content)
    table = response['table']
    expected_columns = ['time', 'latitude', 'longitude', 'u_current', 'v_current']
    if table['columnNames'] != expected_columns or table['columnUnits'] != ['UTC', 'degrees_north', 'degrees_east', 'm/s', 'm/s']:
        raise ValueError('Unexpected NOAA current fields or units')
    rows = table['rows']
    if len(rows) != 46800 or any(not isinstance(row, list) or len(row) != 5 for row in rows):
        raise ValueError('Incomplete NOAA current grid')
    valid_times = {row[0] for row in rows}
    if len(valid_times) != 1:
        raise ValueError('Expected one current analysis time')
    valid_time = valid_times.pop()
    timestamp = seconds(valid_time)
    if not 946684800 < timestamp < time.time() + 86400:
        raise ValueError('Invalid current analysis time')
    latitudes = sorted({round(row[1], 4) for row in rows})
    longitudes = sorted({round(row[2], 4) for row in rows})
    if len(latitudes) != 130 or len(longitudes) != 360:
        raise ValueError('Unexpected NOAA grid dimensions')
    for coordinates in (latitudes, longitudes):
        if any(abs(coordinates[index] - coordinates[index - 1] - 1) > 0.001 for index in range(1, len(coordinates))):
            raise ValueError('Irregular sampled current coordinates')
    if abs(latitudes[0] + 64.7) > 0.001 or abs(longitudes[0] + 179.9) > 0.001:
        raise ValueError('Unexpected current grid origin')
    source_u, source_v = [None] * len(rows), [None] * len(rows)
    seen = set()
    for _, latitude, longitude, eastward, northward in rows:
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (latitude, longitude)):
            raise ValueError('Invalid current coordinates')
        index = round(latitude - latitudes[0]) * 360 + round(longitude - longitudes[0])
        if not 0 <= index < len(rows) or index in seen:
            raise ValueError('Duplicate or invalid current cell')
        seen.add(index)
        if eastward is None or northward is None:
            continue
        if not all(isinstance(v, (int, float)) and math.isfinite(v) and abs(v) <= 3.2767 for v in (eastward, northward)):
            raise ValueError('Invalid or unrepresentable NOAA current value')
        source_u[index], source_v[index] = eastward, northward
    width, height = 360, 180
    u, v, mask = [0] * (width * height), [0] * (width * height), bytearray(width * height)
    for y in range(height):
        latitude = -90 + y + 0.5
        sy = latitude - latitudes[0]
        if sy < 0 or sy > len(latitudes) - 1:
            continue
        y0 = math.floor(sy)
        y1, fy = min(y0 + 1, len(latitudes) - 1), sy - y0
        for x in range(width):
            longitude = -180 + x + 0.5
            sx = (longitude - longitudes[0]) % 360
            x0, fx = math.floor(sx), sx - math.floor(sx)
            ids = [y0 * 360 + x0, y0 * 360 + (x0 + 1) % 360, y1 * 360 + x0, y1 * 360 + (x0 + 1) % 360]
            if any(source_u[i] is None or source_v[i] is None for i in ids):
                continue
            weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]
            dest = y * width + x
            u[dest] = round(sum(source_u[i] * w for i, w in zip(ids, weights)) * 10000)
            v[dest] = round(sum(source_v[i] * w for i, w in zip(ids, weights)) * 10000)
            mask[dest] = 1
    count = sum(mask)
    if count < 10000:
        raise ValueError('Too few valid ocean current cells')
    source = SOURCE.encode('utf-8')
    resolution = b'1deg display / 0.2deg source'
    header = struct.pack('<4sHHHffffdH', b'OACF', 1, width, height, -180, -90, 1, 1, timestamp * 1000, len(source))
    binary = (header + source + struct.pack('<H', len(resolution)) + resolution + b'\x00'
              + struct.pack('<' + 'h' * len(u), *u) + struct.pack('<' + 'h' * len(v), *v) + bytes(mask))
    metadata = {
        'version': 1, 'source': SOURCE, 'sourceUrl': SOURCE_PAGE, 'requestUrl': SOURCE_URL,
        'kind': 'Satellite-derived geostrophic current analysis', 'simulated': False,
        'validTime': valid_time, 'timestamp': valid_time, 'downloadedAt': downloaded_at or iso(),
        'updatedAt': downloaded_at or iso(), 'sourceCadence': 'daily; publication lag is retained',
        'coverage': '64.7 S to 64.7 N; missing cells and polar regions remain masked',
        'sourceResolution': '0.2 degree', 'sampledResolution': '1 degree',
        'resolution': '1 degree display / 0.2 degree source',
        'displayResampling': 'Bilinear interpolation only where all four source cells have data',
        'width': width, 'height': height, 'lon0': -180, 'lat0': -90, 'dLon': 1, 'dLat': 1,
        'units': {'u': 'm/s eastward', 'v': 'm/s northward'},
        'quantization': 'OACF signed int16 at 0.0001 m/s; no clipped values',
        'validCells': count, 'missingCells': len(mask) - count,
        'sourceValidCells': sum(item is not None for item in source_u),
        'license': 'May be used and redistributed for free; NOAA/AOML supplied without warranty',
        'limitations': 'Geostrophic component only, not total currents, tides, waves or a navigation forecast.',
        'bytes': len(binary), 'sha256': hashlib.sha256(binary).hexdigest(),
        'sourceResponseSha256': hashlib.sha256(content).hexdigest(),
    }
    return metadata, binary


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes(content)
    temporary.replace(path)


def write_snapshot(project_root, metadata, binary):
    directory = Path(project_root) / 'data' / 'services-current'
    result = dict(metadata)
    name = 'aoml-geostrophic-' + metadata['sha256'][:16] + '.oacf'
    result['file'] = '/data/services-current/' + name
    atomic_write(directory / name, binary)
    atomic_write(directory / 'manifest.json', json.dumps(result, ensure_ascii=False, indent=2).encode('utf-8'))
    return result


class CurrentsService:
    def __init__(self, project_root):
        self.root = Path(project_root).resolve()
        self.cache = self.root / '.runtime' / 'currents'
        self.snapshot = self.root / 'data' / 'services-current'
        self.lock = threading.RLock()
        self.refreshing = False
        self.last_attempt = 0
        self.last_checked = None
        self.error = None
        self.robots_checked = 0
        self.cached = None
        self._load_cache()

    def _load_cache(self):
        for folder in (self.snapshot, self.cache):
            try:
                meta = json.loads((folder / 'manifest.json').read_text('utf-8'))
                name = meta['file'].rsplit('/', 1)[-1]
                if not ASSET_PATTERN.fullmatch(name):
                    raise ValueError('Invalid cached current name')
                binary = (folder / name).read_bytes()
                if len(binary) != meta['bytes'] or hashlib.sha256(binary).hexdigest() != meta['sha256']:
                    raise ValueError('Cached current integrity mismatch')
                if binary[:4] != b'OACF' or not math.isfinite(seconds(meta['validTime'])):
                    raise ValueError('Invalid cached current format')
                if not self.cached or seconds(meta['downloadedAt']) >= seconds(self.cached['downloadedAt']):
                    self.cached = meta
            except (OSError, ValueError, KeyError, TypeError):
                pass
        try:
            state = json.loads((self.cache / 'state.json').read_text('utf-8'))
            self.last_checked, self.error = state.get('lastChecked'), state.get('error')
            self.last_attempt = seconds(self.last_checked) if self.last_checked else 0
        except (OSError, ValueError, TypeError):
            pass

    def status(self):
        with self.lock:
            valid = self.cached.get('validTime') if self.cached else None
            downloaded = self.cached.get('downloadedAt') if self.cached else None
            checked_recently = downloaded and 0 <= time.time() - seconds(downloaded) < REFRESH_SECONDS
            return {
                'state': 'refreshing' if self.refreshing else 'error' if self.error else 'ready' if self.cached else 'idle',
                'refreshing': self.refreshing, 'enabled': True,
                'source': SOURCE, 'sourceUrl': SOURCE_PAGE,
                'mode': 'online' if checked_recently and not self.error else 'cached' if self.cached else 'unavailable',
                'validTime': valid, 'downloadedAt': downloaded, 'lastChecked': self.last_checked,
                'ageHours': round(max(0, time.time() - seconds(valid)) / 3600, 1) if valid else None,
                'refreshIntervalSeconds': REFRESH_SECONDS, 'minimumRefreshSeconds': MIN_REFRESH_SECONDS,
                'error': self.error, 'coverage': '64.7 S to 64.7 N, geostrophic component only',
                'simulated': False,
            }

    def manifest(self, auto_refresh=True):
        if auto_refresh:
            self.refresh(force=False)
        with self.lock:
            if not self.cached:
                return {'file': None, 'currentStatus': self.status(), 'source': SOURCE}
            result = dict(self.cached)
            result['currentStatus'] = self.status()
            return result

    def asset_path(self, name):
        if not isinstance(name, str) or not ASSET_PATTERN.fullmatch(name):
            return None
        for directory in (self.cache, self.snapshot):
            path = directory / name
            if path.is_file():
                return path
        return None

    def refresh(self, force=True):
        with self.lock:
            now = time.time()
            due = not self.cached or not 0 <= now - seconds(self.cached['downloadedAt']) < REFRESH_SECONDS
            if self.refreshing or 0 <= now - self.last_attempt < MIN_REFRESH_SECONDS or (not force and not due):
                return self.status()
            self.refreshing, self.last_attempt, self.last_checked = True, now, iso(now)
            threading.Thread(target=self._run_refresh, name='atlas-aoml-currents', daemon=True).start()
            return self.status()

    def _check_robots(self):
        if time.time() - self.robots_checked < 86400:
            return
        url = 'https://cwcgom.aoml.noaa.gov/robots.txt'
        try:
            with urlopen(Request(url, headers={'User-Agent': USER_AGENT}), timeout=12) as response:
                content = response.read(256 * 1024).decode('utf-8', errors='replace')
        except HTTPError as error:
            if error.code in (404, 410):
                self.robots_checked = time.time()
                return
            raise ValueError('Cannot check NOAA current robots.txt: ' + str(error)) from error
        parser = RobotFileParser(url)
        parser.parse(content.splitlines())
        if not parser.can_fetch(USER_AGENT, SOURCE_URL):
            raise ValueError('NOAA current source robots.txt disallows this request')
        self.robots_checked = time.time()

    def _run_refresh(self):
        try:
            self._check_robots()
            request = Request(SOURCE_URL, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
            with urlopen(request, timeout=45) as response:
                if urlsplit(response.geturl()).hostname != 'cwcgom.aoml.noaa.gov':
                    raise ValueError('Unexpected current source redirect')
                content = response.read(MAX_BYTES + 1)
            if len(content) > MAX_BYTES:
                raise ValueError('Current response exceeds size limit')
            metadata, binary = convert_response(content)
            if self.cached and seconds(metadata['validTime']) < seconds(self.cached['validTime']):
                raise ValueError('Upstream current analysis is older than the saved grid')
            name = 'aoml-geostrophic-' + metadata['sha256'][:16] + '.oacf'
            metadata['file'] = '/__local/currents/files/' + name
            atomic_write(self.cache / name, binary)
            atomic_write(self.cache / 'manifest.json', json.dumps(metadata, ensure_ascii=False, indent=2).encode('utf-8'))
            with self.lock:
                self.cached, self.error = metadata, None
                # Keep one previous response for tabs loading its manifest.
                old = sorted(self.cache.glob('aoml-geostrophic-*.oacf'), key=lambda p: p.stat().st_mtime, reverse=True)
                for path in old[2:]:
                    if path.resolve().is_relative_to(self.cache) and time.time() - path.stat().st_mtime > 7200:
                        path.unlink(missing_ok=True)
        except Exception as error:
            with self.lock:
                self.error = str(error)[:500]
        finally:
            with self.lock:
                self.refreshing = False
                state = self.status()
            try:
                atomic_write(self.cache / 'state.json', json.dumps(state, ensure_ascii=False, indent=2).encode('utf-8'))
            except OSError:
                pass


if __name__ == '__main__':
    service = CurrentsService(Path(__file__).resolve().parent)
    service.refresh()
    while service.status()['refreshing']:
        time.sleep(0.2)
    print(json.dumps(service.status(), ensure_ascii=False, indent=2))
