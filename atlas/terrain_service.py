"""On-demand Mapzen Terrarium tiles, with a bounded local cache.

Only fixed public AWS terrain URLs are fetched. This is not a general proxy or
crawler. The original Cesium heightmap decoder consumes these PNGs unchanged.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser
import zlib

BASE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/'
SOURCE = 'Mapzen Terrain Tiles · USGS / SRTM / GMTED / ETOPO1'
SOURCE_PAGE = 'https://registry.opendata.aws/terrain-tiles/'
ATTRIBUTION = 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md'
MAX_TILE_BYTES = 1024 * 1024
CACHE_BYTES = 128 * 1024 * 1024
CACHE_AGE_SECONDS = 365 * 86400


def _iso(timestamp=None):
    return datetime.fromtimestamp(timestamp or time.time(), timezone.utc).isoformat().replace('+00:00', 'Z')


def validate_png(data):
    if len(data) < 45 or data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Terrain server did not return a PNG')
    if data[12:16] != b'IHDR' or struct.unpack('>II', data[16:24]) != (256, 256):
        raise ValueError('Unexpected terrain tile dimensions')
    if data[24] != 8 or data[25] not in (2, 6):
        raise ValueError('Expected an 8-bit RGB/RGBA Terrarium tile')
    pos, ended = 8, False
    while pos + 12 <= len(data):
        length = struct.unpack_from('>I', data, pos)[0]
        end = pos + length + 12
        if end > len(data):
            raise ValueError('Truncated terrain PNG')
        actual = zlib.crc32(data[pos + 4:end - 4]) & 0xffffffff
        if actual != struct.unpack_from('>I', data, end - 4)[0]:
            raise ValueError('Invalid terrain PNG checksum')
        if data[pos + 4:pos + 8] == b'IEND':
            ended = True
            break
        pos = end
    if not ended:
        raise ValueError('Incomplete terrain PNG')


class TerrainService:
    def __init__(self, project_root):
        self.cache = Path(project_root).resolve() / '.runtime' / 'terrain'
        self.cache.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._slots = threading.BoundedSemaphore(6)
        self._inflight = {}
        self._failed = {}
        self._last_error = None
        self._downloaded = 0
        self._cache_hits = 0
        self._robots_checked = 0
        self._robots_lock = threading.Lock()
        self._robots_parser = None

    def _check_robots(self, target):
        with self._robots_lock:
            if time.time() - self._robots_checked < 86400:
                if self._robots_parser and not self._robots_parser.can_fetch('SolarSystemAtlasLocal/4.0', target):
                    raise ValueError('Terrain source robots.txt disallows this tile')
                return
            url = 'https://elevation-tiles-prod.s3.amazonaws.com/robots.txt'
            try:
                with urlopen(Request(url, headers={'User-Agent': 'SolarSystemAtlasLocal/4.0'}), timeout=8) as response:
                    content = response.read(256 * 1024).decode('utf-8', errors='replace')
            except HTTPError as error:
                if error.code in (404, 410):
                    self._robots_checked = time.time()
                    self._robots_parser = None
                    return
                raise ValueError('Cannot check terrain robots.txt: ' + str(error)) from error
            parser = RobotFileParser(url)
            parser.parse(content.splitlines())
            self._robots_parser = parser
            self._robots_checked = time.time()
            if not parser.can_fetch('SolarSystemAtlasLocal/4.0', target):
                raise ValueError('Terrain source robots.txt disallows terrain tiles')

    @staticmethod
    def _coordinates(z, x, y):
        values = []
        for value in (z, x, y):
            if isinstance(value, bool) or str(value) != str(int(value)):
                raise ValueError('Invalid terrain coordinate')
            values.append(int(value))
        z, x, y = values
        if not (0 <= z <= 15 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
            raise ValueError('Terrain tile is outside supported bounds')
        return z, x, y

    def tile_path(self, z, x, y, online=True):
        """Return a validated cached/downloaded PNG Path, or None if unavailable."""
        z, x, y = self._coordinates(z, x, y)
        key = f'{z}/{x}/{y}'
        path = self.cache / str(z) / str(x) / f'{y}.png'
        now = time.time()
        with self._lock:
            cached = path.is_file()
            if cached and (not online or now - path.stat().st_mtime < CACHE_AGE_SECONDS):
                self._cache_hits += 1
                return path
            if not online or now - self._failed.get(key, 0) < 60:
                return path if cached else None
            event = self._inflight.get(key)
            if event is None:
                event = threading.Event()
                self._inflight[key] = event
                owner = True
            else:
                owner = False
        if not owner:
            event.wait(20)
            return path if path.is_file() else None
        try:
            with self._slots:
                url = BASE_URL + key + '.png'
                self._check_robots(url)
                request = Request(url, headers={'User-Agent': 'SolarSystemAtlasLocal/4.0 (public terrain data client)'})
                with urlopen(request, timeout=12) as response:
                    if response.geturl() != url:
                        raise ValueError('Unexpected terrain redirect')
                    data = response.read(MAX_TILE_BYTES + 1)
                if len(data) > MAX_TILE_BYTES:
                    raise ValueError('Terrain tile exceeds size limit')
                validate_png(data)
                metadata = {
                    'source': SOURCE, 'url': url, 'sourcePage': SOURCE_PAGE,
                    'attribution': ATTRIBUTION,
                    'license': 'Source-specific open DEM licenses; see attribution',
                    'downloadedAt': _iso(), 'sha256': hashlib.sha256(data).hexdigest(),
                    'bytes': len(data), 'encoding': '(R * 256 + G + B / 256) - 32768 meters',
                    'z': z, 'x': x, 'y': y, 'content': 'Elevation model; not a live observation',
                }
                path.parent.mkdir(parents=True, exist_ok=True)
                temp = path.with_suffix('.png.part')
                temp.write_bytes(data)
                temp.replace(path)
                meta = path.with_suffix('.json')
                temp_meta = meta.with_suffix('.json.part')
                temp_meta.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), 'utf-8')
                temp_meta.replace(meta)
                with self._lock:
                    self._downloaded += 1
                    self._last_error = None
                    self._failed.pop(key, None)
                    self._prune(keep=path)
                return path
        except Exception as error:
            with self._lock:
                self._last_error = str(error)
                self._failed[key] = time.time()
                if len(self._failed) > 256:
                    del self._failed[next(iter(self._failed))]
            return path if path.is_file() else None
        finally:
            with self._lock:
                self._inflight.pop(key, None)
                event.set()

    def _prune(self, keep):
        files = sorted(self.cache.glob('*/*/*.png'), key=lambda item: item.stat().st_mtime)
        total = sum(item.stat().st_size for item in files)
        for item in files:
            if total <= CACHE_BYTES:
                break
            if item == keep:
                continue
            # Every candidate is a tile beneath the fixed cache root.
            if not item.resolve().is_relative_to(self.cache):
                continue
            total -= item.stat().st_size
            item.unlink(missing_ok=True)
            item.with_suffix('.json').unlink(missing_ok=True)

    def status(self):
        with self._lock:
            files = list(self.cache.glob('*/*/*.png'))
            return {
                'source': SOURCE, 'sourceUrl': SOURCE_PAGE, 'attribution': ATTRIBUTION,
                'enabled': True, 'mode': 'on-demand elevation model',
                'cachedTiles': len(files), 'cachedBytes': sum(p.stat().st_size for p in files),
                'cacheLimitBytes': CACHE_BYTES, 'cacheMaxAgeDays': 365,
                'downloadedThisRun': self._downloaded, 'cacheHitsThisRun': self._cache_hits,
                'pending': len(self._inflight), 'lastError': self._last_error,
                'offlineBehavior': 'Reuse requested cached tiles; unavailable regions retain ellipsoid',
            }
