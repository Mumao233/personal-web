"""Public GFS grid refresh for the local atlas (Python standard library only).

The original archived weather files are never changed. Successful downloads are
validated and atomically committed to .runtime/weather, with their source URL,
forecast time, model run time, units, download time and SHA-256 checksums.
"""
from __future__ import annotations

from array import array
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser

SOURCE = 'NOAA / NCEP GFS via NSF Unidata NCSS'
BASE_URL = 'https://tds.scigw.unidata.ucar.edu/thredds/ncss/grid/grib/NCEP/GFS/Global_0p25deg/Best'
VARIABLES = (
    'u-component_of_wind_height_above_ground',
    'v-component_of_wind_height_above_ground',
    'Precipitation_rate_surface',
    'Total_cloud_cover_entire_atmosphere',
)
SOURCE_URL = BASE_URL + '?' + urlencode(
    [('var', item) for item in VARIABLES] + [
        ('north', 90), ('south', -90), ('west', 0), ('east', 360),
        ('horizStride', 1), ('time', 'present'), ('vertCoord', 10), ('accept', 'netcdf3'),
    ])
USER_AGENT = 'SolarSystemAtlasLocal/3.0 (public weather data client)'
MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024
CHUNK_BYTES = 512 * 1024
REFRESH_SECONDS = 3600
MIN_REFRESH_SECONDS = 300
CHUNK_NAME = re.compile(r'gfs-(?:surface|clouds)-[a-f0-9]{16}-\d{2,3}\.bin\Z')
GRID_NAME = re.compile(r'gfs-(?:surface|clouds)-[a-f0-9]{64}\.bin\Z')


def utc_iso(value=None):
    if value is None:
        value = datetime.now(timezone.utc)
    if isinstance(value, (int, float)):
        value = datetime.fromtimestamp(value, timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def iso_seconds(value):
    if not isinstance(value, str):
        raise ValueError('Expected an ISO timestamp string')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


class WeatherDataError(ValueError):
    pass


class ClassicNetCDF:
    """Read the fixed-size numeric variables in NCSS's NetCDF classic output.

    CDF1/CDF2 only; reject record variables, unexpected types, bounds and shapes.
    This is deliberately not a general-purpose NetCDF/HDF5 reader.
    """
    TYPES = {1: ('b', 1), 2: ('c', 1), 3: ('h', 2), 4: ('i', 4), 5: ('f', 4), 6: ('d', 8)}

    def __init__(self, content):
        if content[:4] not in (b'CDF\x01', b'CDF\x02'):
            raise WeatherDataError('Expected public NCSS NetCDF classic data, not an HTML response')
        self.content = content
        self.version = content[3]
        self.pos = 4
        self.num_records = self.uint()
        if self.num_records:
            raise WeatherDataError('Unexpected record variables in single-time weather subset')
        self.dimensions = []
        for _ in range(self.list_count(10)):
            self.dimensions.append((self.string(), self.uint()))
        if any(not size for _, size in self.dimensions):
            raise WeatherDataError('Unexpected unlimited dimension')
        self.attributes = self.attrs()
        self.variables = {}
        for _ in range(self.list_count(11)):
            name = self.string()
            dim_count = self.uint()
            if dim_count > 8:
                raise WeatherDataError('Too many dimensions')
            dim_ids = [self.uint() for _ in range(dim_count)]
            if any(item >= len(self.dimensions) for item in dim_ids):
                raise WeatherDataError('Invalid variable dimensions')
            attributes = self.attrs()
            kind, stored_size = self.uint(), self.uint()
            begin = self.uint64() if self.version == 2 else self.uint()
            if kind not in self.TYPES:
                raise WeatherDataError('Unsupported NetCDF numeric type')
            shape = [self.dimensions[item][1] for item in dim_ids]
            count = math.prod(shape)
            size = count * self.TYPES[kind][1]
            if size > stored_size or begin + size > len(content):
                raise WeatherDataError('Truncated NetCDF variable')
            self.variables[name] = {
                'dimensions': [self.dimensions[item][0] for item in dim_ids],
                'shape': shape, 'type': kind, 'begin': begin, 'size': size,
                'attributes': attributes,
            }

    def uint(self):
        if self.pos + 4 > len(self.content):
            raise WeatherDataError('Truncated NetCDF header')
        value = struct.unpack_from('>I', self.content, self.pos)[0]
        self.pos += 4
        return value

    def uint64(self):
        return (self.uint() << 32) | self.uint()

    def string(self):
        size = self.uint()
        if size > 65536 or self.pos + size > len(self.content):
            raise WeatherDataError('Invalid NetCDF string')
        value = self.content[self.pos:self.pos + size].decode('utf-8')
        self.pos += (size + 3) // 4 * 4
        return value

    def list_count(self, expected):
        tag, count = self.uint(), self.uint()
        if (tag, count) == (0, 0):
            return 0
        if tag != expected or count > 256:
            raise WeatherDataError('Invalid NetCDF list')
        return count

    def attrs(self):
        result = {}
        for _ in range(self.list_count(12)):
            key, kind, count = self.string(), self.uint(), self.uint()
            if kind not in self.TYPES:
                raise WeatherDataError('Unsupported NetCDF attribute')
            code, itemsize = self.TYPES[kind]
            size = count * itemsize
            if size > 1024 * 1024 or self.pos + size > len(self.content):
                raise WeatherDataError('Invalid NetCDF attribute size')
            raw = self.content[self.pos:self.pos + size]
            result[key] = raw.decode('utf-8') if kind == 2 else struct.unpack('>' + code * count, raw)
            self.pos += (size + 3) // 4 * 4
        return result

    def values(self, name):
        if name not in self.variables:
            raise WeatherDataError('Missing required variable: ' + name)
        variable = self.variables[name]
        code, _ = self.TYPES[variable['type']]
        if code not in ('f', 'd', 'i', 'h', 'b'):
            raise WeatherDataError('Non-numeric weather variable')
        values = array(code)
        values.frombytes(self.content[variable['begin']:variable['begin'] + variable['size']])
        if sys.byteorder == 'little' and values.itemsize > 1:
            values.byteswap()
        if not all(math.isfinite(value) for value in values):
            raise WeatherDataError('Non-finite weather data in ' + name)
        return values

    def time(self, name):
        values = self.values(name)
        if len(values) != 1:
            raise WeatherDataError('Expected exactly one forecast time')
        units = self.variables[name]['attributes'].get('units', '')
        match = re.fullmatch(r'(hours?|days?|minutes?|seconds?) since (.+)', units, re.I)
        if not match:
            raise WeatherDataError('Unsupported time units: ' + units)
        unit, origin = match.groups()
        factor = {'h': 3600, 'd': 86400, 'm': 60, 's': 1}[unit.lower()[0]]
        start = datetime.fromisoformat(origin.replace('Z', '+00:00'))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        return utc_iso(start + timedelta(seconds=values[0] * factor))

    def coordinate_time(self, name, standard_name='time'):
        variable = self.variables[name]
        candidates = variable['dimensions'] + variable['attributes'].get('coordinates', '').split()
        selected = {item for item in candidates if item in self.variables
                    and self.variables[item]['attributes'].get('standard_name') == standard_name}
        if len(selected) != 1:
            raise WeatherDataError('Expected one ' + standard_name + ' coordinate for ' + name)
        return self.time(selected.pop())


def convert_netcdf(content, downloaded_at=None):
    """Return original-layout metadata and validated little-endian float grids."""
    dataset = ClassicNetCDF(content)
    latitudes = dataset.values('latitude')
    source_longitudes = dataset.values('longitude')
    longitudes = [(value + 180) % 360 - 180 for value in source_longitudes]
    width, height = len(longitudes), len(latitudes)
    if not 360 <= width <= 2880 or not 181 <= height <= 1441:
        raise WeatherDataError('Unexpected global grid resolution')
    xs = sorted(range(width), key=longitudes.__getitem__)
    ys = sorted(range(height), key=latitudes.__getitem__)
    lon0, lat0 = longitudes[xs[0]], latitudes[ys[0]]
    dlon = longitudes[xs[1]] - lon0
    dlat = latitudes[ys[1]] - lat0
    if (abs(lon0 + 180) > 0.001 or abs(lat0 + 90) > 0.001
            or abs(dlon * width - 360) > 0.001
            or abs(dlat * (height - 1) - 180) > 0.001
            or any(abs(longitudes[x] - (lon0 + i * dlon)) > 0.001 for i, x in enumerate(xs))
            or any(abs(latitudes[y] - (lat0 + i * dlat)) > 0.001 for i, y in enumerate(ys))):
        raise WeatherDataError('Expected a complete uniformly spaced global grid')
    # NCSS native longitude rows are contiguous, with one Greenwich/dateline wrap.
    pivot = xs[0]
    if xs != list(range(pivot, width)) + list(range(pivot)):
        raise WeatherDataError('Unexpected longitude storage order')
    fields = []
    ranges = {}
    forecast_times = {}
    model_run_times = {}
    expected_units = ('m/s', 'm/s', 'kg.m-2.s-1', '%')
    scales = (1, 1, 3600, 0.01)
    for name, unit, scale in zip(VARIABLES, expected_units, scales):
        info = dataset.variables.get(name)
        if not info or info['attributes'].get('units') != unit:
            raise WeatherDataError('Unexpected physical units for ' + name)
        if info['shape'][-2:] != [height, width] or math.prod(info['shape'][:-2]) != 1:
            raise WeatherDataError('Unexpected weather variable shape')
        if info['dimensions'][-2:] != ['latitude', 'longitude']:
            raise WeatherDataError('Unexpected spatial dimension order')
        forecast_times[name] = dataset.coordinate_time(name)
        model_run_times[name] = dataset.coordinate_time(name, 'forecast_reference_time')
        if name in VARIABLES[:2]:
            heights = [dim for dim in info['dimensions'] if dim.startswith('height_above_ground')]
            if (len(heights) != 1 or list(dataset.values(heights[0])) != [10.0]
                    or dataset.variables[heights[0]]['attributes'].get('units') != 'm'):
                raise WeatherDataError('Expected wind at 10 metres above ground')
        values = dataset.values(name)
        low, high = min(values), max(values)
        if name == VARIABLES[2] and (low < -0.000001 or high > 1):
            raise WeatherDataError('Implausible precipitation rate')
        if name == VARIABLES[3] and (low < -0.001 or high > 100.001):
            raise WeatherDataError('Implausible cloud fraction')
        if name in VARIABLES[:2] and max(abs(low), abs(high)) > 200:
            raise WeatherDataError('Implausible 10-metre wind velocity')
        ordered = array('f')
        for y in ys:
            start = y * width
            ordered.extend(values[start + pivot:start + width])
            ordered.extend(values[start:start + pivot])
        if scale != 1:
            ordered = array('f', (max(0, value * scale) for value in ordered))
        fields.append(ordered)
        ranges[name] = [min(ordered), max(ordered)]
    surface = array('f', [0]) * (width * height * 3)
    for channel in range(3):
        surface[channel::3] = fields[channel]
    clouds = fields[3]
    if sys.byteorder != 'little':
        surface.byteswap()
        clouds.byteswap()
    valid_time = forecast_times[VARIABLES[0]]
    if forecast_times[VARIABLES[1]] != valid_time:
        raise WeatherDataError('Wind vector components have different forecast times')
    model_run_time = model_run_times[VARIABLES[0]]
    now = iso_seconds(downloaded_at) if downloaded_at else time.time()
    if any(abs(iso_seconds(value) - now) > 48 * 3600 for value in forecast_times.values()):
        raise WeatherDataError('Source did not return a current forecast (more than 48 hours away)')
    metadata = {
        'source': SOURCE, 'url': SOURCE_URL,
        'validTime': valid_time, 'rainTime': forecast_times[VARIABLES[2]], 'cloudTime': forecast_times[VARIABLES[3]],
        'modelRunTime': model_run_time, 'downloadedAt': downloaded_at or utc_iso(),
        'variableValidTimes': forecast_times, 'variableModelRunTimes': model_run_times,
        'width': width, 'height': height, 'lon0': lon0, 'lat0': lat0,
        'dLon': dlon, 'dLat': dlat,
        'channels': ['eastward wind m/s', 'northward wind m/s', 'precipitation rate mm/h'],
        'cloudUnits': 'fraction 0..1',
        'nativeResolution': f'{dlon:g}°', 'displayResolution': f'{dlon:g}°',
        'license': 'US government data; served by NSF Unidata',
        'dataKind': 'numerical model forecast; not an observation',
        'upstreamFormat': 'NetCDF classic',
        'upstreamBytes': len(content), 'upstreamSha256': hashlib.sha256(content).hexdigest(),
        'valueRanges': ranges,
    }
    return metadata, surface.tobytes(), clouds.tobytes()


class WeatherLive:
    """One local server instance; read endpoints are safe during a refresh."""

    def __init__(self, root):
        self.root = Path(root).resolve()
        self.cache = self.root / '.runtime' / 'weather'
        self.lock = threading.RLock()
        self.refreshing = False
        self.last_checked = None
        self.last_success = None
        self.last_attempt = 0
        self.error = None
        self.cached = None
        self.robots_checked = 0
        self._load_cache()

    def _load_cache(self):
        try:
            metadata = json.loads((self.cache / 'manifest.json').read_text(encoding='utf-8'))
            width, height = metadata['width'], metadata['height']
            if not isinstance(width, int) or not isinstance(height, int) or not 360 <= width <= 2880 or not 181 <= height <= 1441:
                raise WeatherDataError('Invalid cached weather dimensions')
            iso_seconds(metadata['validTime'])
            grids = []
            for key in ('binaryParts', 'cloudBinaryParts'):
                blocks = []
                expected_bytes = width * height * (12 if key == 'binaryParts' else 4)
                if sum(part['bytes'] for part in metadata[key]) != expected_bytes:
                    raise WeatherDataError('Invalid cached weather byte count')
                for part in metadata[key]:
                    path = self.asset_path(part['url'].rsplit('/', 1)[-1])
                    if path is None:
                        raise WeatherDataError('Missing cached weather part')
                    content = path.read_bytes()
                    if len(content) != part['bytes'] or hashlib.sha256(content).hexdigest() != part['sha256']:
                        raise WeatherDataError('Cached weather checksum mismatch')
                    blocks.append(content)
                grids.append(b''.join(blocks))
            # Older manifests used mutable full-grid aliases. Reconstruct from
            # the verified chunks, including after an interrupted old commit.
            self._write_full_grids(metadata, *grids)
            self.cached = metadata
            self.last_success = metadata['downloadedAt']
            iso_seconds(self.last_success)
        except (OSError, ValueError, KeyError, TypeError):
            self.cached = None
            self.last_success = None
        try:
            state = json.loads((self.cache / 'state.json').read_text(encoding='utf-8'))
            self.last_checked = state.get('lastChecked')
            self.error = state.get('error')
            if self.last_checked:
                self.last_attempt = iso_seconds(self.last_checked)
        except (OSError, ValueError, TypeError):
            pass

    def _status(self):
        now = time.time()
        fresh = bool(self.cached and self.last_success and 0 <= now - iso_seconds(self.last_success) < REFRESH_SECONDS and not self.error)
        return {
            'state': 'refreshing' if self.refreshing else 'error' if self.error else 'ready' if self.cached else 'idle',
            'refreshing': self.refreshing,
            'mode': 'live' if fresh else 'cached' if self.cached else 'archive',
            'source': SOURCE,
            'validTime': self.cached.get('validTime') if self.cached else None,
            'downloadedAt': self.last_success,
            'lastChecked': self.last_checked,
            'lastSuccess': self.last_success,
            'nextAllowed': utc_iso(max(now, self.last_attempt + MIN_REFRESH_SECONDS)),
            'error': self.error,
            'refreshIntervalSeconds': REFRESH_SECONDS,
            'minimumRefreshSeconds': MIN_REFRESH_SECONDS,
        }

    def status(self):
        with self.lock:
            return self._status()

    def manifest(self, auto_refresh=True):
        if auto_refresh:
            self.refresh(force=False)
        with self.lock:
            metadata = dict(self.cached) if self.cached else json.loads(
                (self.root / 'weather' / 'gfs-surface.json').read_text(encoding='utf-8-sig'))
            state = self._status()
            # Archived data has its own actual timestamp, even before first success.
            state['validTime'] = metadata['validTime']
            metadata.update(weatherStatus=state, online=state['mode'] == 'live', refreshFailed=bool(self.error))
            return metadata

    def refresh(self, force=True):
        with self.lock:
            now = time.time()
            due = not self.last_success or not 0 <= now - iso_seconds(self.last_success) < REFRESH_SECONDS
            if self.refreshing or 0 <= now - self.last_attempt < MIN_REFRESH_SECONDS or (not force and not due):
                return self._status()
            self.refreshing = True
            self.last_attempt = now
            self.last_checked = utc_iso(now)
            thread = threading.Thread(target=self._run_refresh, name='atlas-public-gfs-refresh', daemon=True)
            thread.start()
            return self._status()

    def asset_path(self, name):
        if not isinstance(name, str) or not CHUNK_NAME.fullmatch(name):
            return None
        path = self.cache / 'chunks' / name
        return path if path.is_file() else None

    @staticmethod
    def _atomic_write(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.tmp')
        temporary.write_bytes(content)
        os.replace(temporary, path)

    def _check_robots(self):
        if time.time() - self.robots_checked < 24 * 3600:
            return
        parts = urlsplit(BASE_URL)
        url = parts.scheme + '://' + parts.netloc + '/robots.txt'
        request = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'text/plain'})
        try:
            with urlopen(request, timeout=15) as response:
                text = response.read(256 * 1024).decode('utf-8', errors='replace')
        except HTTPError as error:
            if error.code in (404, 410):
                self.robots_checked = time.time()
                return
            raise WeatherDataError(f'Cannot check upstream robots.txt: HTTP {error.code}') from error
        parser = RobotFileParser(url)
        parser.parse(text.splitlines())
        if not parser.can_fetch(USER_AGENT, SOURCE_URL):
            raise WeatherDataError('Upstream robots.txt disallows this weather request')
        self.robots_checked = time.time()

    def _download(self):
        self._check_robots()
        request = Request(SOURCE_URL, headers={'User-Agent': USER_AGENT, 'Accept': 'application/x-netcdf'})
        with urlopen(request, timeout=60) as response:
            if urlsplit(response.url).hostname != urlsplit(BASE_URL).hostname:
                raise WeatherDataError('Unexpected upstream redirect')
            size = response.headers.get('Content-Length')
            if size and int(size) > MAX_DOWNLOAD_BYTES:
                raise WeatherDataError('Upstream weather subset exceeds size limit')
            content = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(content) > MAX_DOWNLOAD_BYTES:
                raise WeatherDataError('Upstream weather subset exceeds size limit')
        return content

    def _commit(self, metadata, surface, clouds):
        metadata = dict(metadata)
        for label, content, key in (('surface', surface, 'binaryParts'), ('clouds', clouds, 'cloudBinaryParts')):
            parts = []
            for number, start in enumerate(range(0, len(content), CHUNK_BYTES)):
                block = content[start:start + CHUNK_BYTES]
                digest = hashlib.sha256(block).hexdigest()
                name = f'gfs-{label}-{digest[:16]}-{number:02d}.bin'
                path = self.cache / 'chunks' / name
                if not path.is_file():
                    self._atomic_write(path, block)
                parts.append({'url': '/__local/weather/chunks/' + name, 'bytes': len(block), 'sha256': digest})
            metadata[key] = parts
        # Both representations are immutable. Only the final manifest replace
        # publishes a generation; failed writes cannot change current aliases.
        self._write_full_grids(metadata, surface, clouds)
        if self.cached:
            self._atomic_write(self.cache / 'previous-manifest.json', json.dumps(self.cached, ensure_ascii=False, indent=2).encode('utf-8'))
        self._atomic_write(self.cache / 'manifest.json', json.dumps(metadata, ensure_ascii=False, indent=2).encode('utf-8'))
        with self.lock:
            self.cached = metadata
            self.last_success = metadata['downloadedAt']
            self.error = None
        self._prune_chunks(metadata)

    def _write_full_grids(self, metadata, surface, clouds):
        for label, content, key in (('surface', surface, 'binary'), ('clouds', clouds, 'cloudBinary')):
            digest = hashlib.sha256(content).hexdigest()
            name = f'gfs-{label}-{digest}.bin'
            path = self.cache / 'grids' / name
            # Repair a damaged derived grid from the verified source chunks.
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                self._atomic_write(path, content)
            metadata[key] = '/__local/weather/grids/' + name

    def _prune_chunks(self, current):
        """Keep current/previous grids and allow two hours for in-flight clients."""
        keep = {part['url'].rsplit('/', 1)[-1]
                for key in ('binaryParts', 'cloudBinaryParts') for part in current[key]}
        grids = {current[key].rsplit('/', 1)[-1] for key in ('binary', 'cloudBinary')}
        try:
            previous = json.loads((self.cache / 'previous-manifest.json').read_text(encoding='utf-8'))
            keep.update(part['url'].rsplit('/', 1)[-1]
                        for key in ('binaryParts', 'cloudBinaryParts') for part in previous[key])
            grids.update(previous[key].rsplit('/', 1)[-1] for key in ('binary', 'cloudBinary'))
        except (OSError, ValueError, KeyError, TypeError):
            pass
        for path in (self.cache / 'chunks').glob('*.bin'):
            try:
                path.resolve().relative_to(self.cache.resolve())
                if CHUNK_NAME.fullmatch(path.name) and path.name not in keep and time.time() - path.stat().st_mtime > 7200:
                    path.unlink()
            except (OSError, ValueError):
                pass
        for path in (self.cache / 'grids').glob('*.bin'):
            try:
                path.resolve().relative_to(self.cache.resolve())
                if GRID_NAME.fullmatch(path.name) and path.name not in grids and time.time() - path.stat().st_mtime > 7200:
                    path.unlink()
            except (OSError, ValueError):
                pass

    def full_grid_path(self, name):
        with self.lock:
            if not self.cached or not isinstance(name, str):
                return None
            # Keep the old URLs usable, but resolve them through the committed
            # manifest rather than reading a separately overwritten file.
            if name in ('gfs-surface.bin', 'gfs-clouds.bin'):
                key = 'binary' if name == 'gfs-surface.bin' else 'cloudBinary'
                name = self.cached[key].removeprefix('/__local/weather/')
            if not name.startswith('grids/') or not GRID_NAME.fullmatch(name[6:]):
                return None
            path = self.cache / name
            return path if path.is_file() else None

    def _run_refresh(self):
        try:
            content = self._download()
            metadata, surface, clouds = convert_netcdf(content)
            self._commit(metadata, surface, clouds)
        except Exception as error:
            # Upstream unavailability is data status; existing valid files survive.
            with self.lock:
                self.error = f'{type(error).__name__}: {error}'[:500]
        finally:
            with self.lock:
                self.refreshing = False
                state = self._status()
            try:
                self._atomic_write(self.cache / 'state.json', json.dumps(state, ensure_ascii=False, indent=2).encode('utf-8'))
            except OSError:
                pass


if __name__ == '__main__':
    service = WeatherLive(Path(__file__).resolve().parent)
    service.refresh()
    while service.status()['refreshing']:
        time.sleep(0.2)
    print(json.dumps(service.status(), ensure_ascii=False, indent=2))
