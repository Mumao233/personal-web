"""Bounded public NASA GIBS ocean imagery, with real offline snapshots.

The three products are published satellite/analysis products, not instantaneous
observations. Dates come from GetCapabilities, never from the computer clock.
Python 3.9+ standard library only. No credentials or generic remote proxy.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET
import zlib

ORIGIN = 'https://gibs.earthdata.nasa.gov'
WMS = ORIGIN + '/wms/epsg4326/best/wms.cgi'
CAPABILITIES_URL = WMS + '?SERVICE=WMS&REQUEST=GetCapabilities'
SOURCE = 'NASA EOSDIS GIBS'
USER_AGENT = 'SolarSystemAtlasLocal/4.0 (public satellite imagery client)'
REFRESH_SECONDS = 6 * 3600
MIN_REFRESH_SECONDS = 300
RETRY_SECONDS = 900
MAX_GENERATIONS = 4
WIDTH, HEIGHT = 1024, 512
PRODUCTS = {
    'sst': {
        'layer': 'GHRSST_L4_MUR_Sea_Surface_Temperature',
        'title': '海表温度', 'titleEn': 'Sea surface temperature', 'units': '°C',
        'aggregation': 'GHRSST MUR 每日海表温度分析；不是即时测量',
        'aggregationEn': 'GHRSST MUR daily SST analysis; not an instantaneous measurement',
        'credit': 'NASA EOSDIS GIBS / JPL / GHRSST MUR',
        'legend': 'GHRSST_Sea_Surface_Temperature_H.png',
    },
    'salinity': {
        'layer': 'SMAP_L3_Sea_Surface_Salinity_CAP_8Day_RunningMean',
        'title': '海表盐度', 'titleEn': 'Sea surface salinity', 'units': 'PSU',
        'aggregation': 'SMAP CAP 8 日滑动平均；日期为产品标记日期',
        'aggregationEn': 'SMAP CAP 8-day running mean; date is the product label date',
        'credit': 'NASA EOSDIS GIBS / JPL / SMAP CAP',
        'legend': 'SMAP_Sea_Surface_Salinity_H.png',
    },
    'chlorophyll': {
        'layer': 'MODIS_Aqua_L2_Chlorophyll_A',
        'title': '叶绿素 a', 'titleEn': 'Chlorophyll a', 'units': 'mg/m³',
        'aggregation': 'Aqua MODIS 卫星日影像；云遮挡和未观测处保持透明',
        'aggregationEn': 'Aqua MODIS daily imagery; cloud-obscured and unobserved areas remain transparent',
        'credit': 'NASA EOSDIS GIBS / Ocean Biology DAAC / Aqua MODIS',
        'legend': 'MODIS_Chlorophyll_H.png',
    },
}


class _ProviderRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if not new_url.startswith(ORIGIN + '/'):
            raise ValueError('Ocean provider redirect leaves its allowed host')
        return super().redirect_request(request, fp, code, message, headers, new_url)


def utc_iso(value=None):
    return datetime.fromtimestamp(time.time() if value is None else value,
                                  timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _timestamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError):
        return 0


def _atomic(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_bytes(content)
    temporary.replace(path)


def image_url(kind, valid_date):
    return WMS + '?' + urlencode({
        'SERVICE': 'WMS', 'VERSION': '1.1.1', 'REQUEST': 'GetMap',
        'LAYERS': PRODUCTS[kind]['layer'], 'STYLES': '', 'SRS': 'EPSG:4326',
        'BBOX': '-180,-90,180,90', 'WIDTH': WIDTH, 'HEIGHT': HEIGHT,
        'FORMAT': 'image/png', 'TRANSPARENT': 'TRUE', 'TIME': valid_date,
    })


def validate_png(content, dimensions=None, require_data=False):
    """Validate bounded RGBA PNG, CRCs, dimensions and genuine transparency.

    Alpha can be unfiltered independently of RGB. Counting it verifies that a
    service's HTTP 200 is neither an XML error nor a completely blank map.
    """
    if not content.startswith(b'\x89PNG\r\n\x1a\n') or len(content) > 8 * 1024 * 1024:
        raise ValueError('NASA GIBS did not return a bounded PNG image')
    pos, width, height, compressed = 8, 0, 0, bytearray()
    ended = False
    while pos + 12 <= len(content):
        length = struct.unpack_from('>I', content, pos)[0]
        kind = content[pos + 4:pos + 8]
        body = content[pos + 8:pos + 8 + length]
        if pos + 12 + length > len(content):
            raise ValueError('Truncated PNG')
        crc = struct.unpack_from('>I', content, pos + 8 + length)[0]
        if zlib.crc32(kind + body) & 0xffffffff != crc:
            raise ValueError('PNG checksum mismatch')
        if kind == b'IHDR':
            if length != 13 or width:
                raise ValueError('Invalid PNG header')
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', body)
            if not 0 < width <= 4096 or not 0 < height <= 2048 or (depth, color, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError('Expected non-interlaced 8-bit RGBA imagery')
        elif kind == b'IDAT':
            compressed.extend(body)
        elif kind == b'IEND':
            ended = True
            break
        pos += 12 + length
    if not ended or not width or (dimensions and (width, height) != dimensions):
        raise ValueError('PNG dimensions or terminator are invalid')
    expected = height * (width * 4 + 1)
    decoder = zlib.decompressobj()
    raw = decoder.decompress(bytes(compressed), expected + 1)
    if len(raw) != expected or not decoder.eof or decoder.unconsumed_tail:
        raise ValueError('Invalid PNG compressed pixel data')
    previous = bytearray(width)
    visible = transparent = 0
    stride = width * 4 + 1
    for y in range(height):
        start = y * stride
        mode = raw[start]
        current = bytearray(width)
        for x in range(width):
            value = raw[start + 4 + x * 4]
            left = current[x - 1] if x else 0
            above = previous[x]
            upper_left = previous[x - 1] if x else 0
            if mode == 1:
                value += left
            elif mode == 2:
                value += above
            elif mode == 3:
                value += (left + above) // 2
            elif mode == 4:
                predictor = left + above - upper_left
                a, b, c = abs(predictor - left), abs(predictor - above), abs(predictor - upper_left)
                value += left if a <= b and a <= c else above if b <= c else upper_left
            elif mode != 0:
                raise ValueError('Unknown PNG scanline filter')
            current[x] = value & 255
            if current[x]:
                visible += 1
            else:
                transparent += 1
        previous = current
    if require_data and (not visible or not transparent):
        raise ValueError('Ocean map must contain real data and transparent no-data pixels')
    return {'width': width, 'height': height, 'visiblePixels': visible,
            'transparentPixels': transparent, 'sha256': hashlib.sha256(content).hexdigest()}


def available_dates(dimension, today=None, limit=3):
    today = today or datetime.now(timezone.utc).date()
    results = set()
    for entry in dimension.split(','):
        try:
            bits = entry.strip().split('/')
            first = date.fromisoformat(bits[0][:10])
            last = date.fromisoformat(bits[1][:10]) if len(bits) > 1 else first
        except ValueError:
            continue
        last = min(last, today)
        for offset in range(limit):
            candidate = last - timedelta(days=offset)
            if first <= candidate <= today:
                results.add(candidate.isoformat())
    return sorted(results, reverse=True)[:limit]


class OceanServices:
    def __init__(self, root):
        self.root = Path(root)
        self.runtime = self.root / '.runtime' / 'ocean'
        self.snapshots = self.root / 'data' / 'ocean'
        self._lock = threading.RLock()
        self._cap_lock = threading.Lock()
        self._capabilities = None
        self._robots_checked = 0
        self._records = {}
        self._active = {}
        self._busy = set()
        self._attempts = {}
        self._errors = {}
        self._online = set()
        for kind in PRODUCTS:
            runtime_product = self.runtime / kind
            directories = []
            try:
                pointer = json.loads((runtime_product / 'current.json').read_text(encoding='utf-8'))
                if re.fullmatch(r'[a-f0-9]{64}', pointer['generation']):
                    directories.append(runtime_product / pointer['generation'])
            except (OSError, KeyError, ValueError, TypeError):
                pass
            # Read older single-generation caches as a migration path.
            directories.extend((runtime_product, self.snapshots / kind))
            for directory in directories:
                try:
                    metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf-8'))
                    for name in ('image', 'legend'):
                        content = (directory / (name + '.png')).read_bytes()
                        if hashlib.sha256(content).hexdigest() != metadata[name + 'Sha256']:
                            raise ValueError('Cached image checksum mismatch')
                    if metadata['layer'] != PRODUCTS[kind]['layer']:
                        raise ValueError('Cached product does not match')
                    self._records[kind] = metadata
                    self._active[kind] = directory
                    break
                except (OSError, KeyError, ValueError, TypeError):
                    pass

    def status(self):
        return {'provider': SOURCE, 'automatic': True, 'refreshSeconds': REFRESH_SECONDS,
                'products': {kind: self.metadata(kind, refresh=False) for kind in PRODUCTS}}

    def metadata(self, kind, refresh=True):
        if kind not in PRODUCTS:
            raise ValueError('Unknown ocean product')
        if refresh:
            self.refresh(kind)
        with self._lock:
            result = dict(self._records.get(kind, {}))
            available = bool(result)
            active = self._active.get(kind)
            provenance = 'live' if kind in self._online else 'snapshot' if active == self.snapshots / kind else 'cache'
            result.update({
                'id': kind, 'title': PRODUCTS[kind]['title'], 'titleEn': PRODUCTS[kind]['titleEn'],
                'source': SOURCE, 'credit': PRODUCTS[kind]['credit'],
                'units': PRODUCTS[kind]['units'], 'aggregation': PRODUCTS[kind]['aggregation'],
                'aggregationEn': PRODUCTS[kind]['aggregationEn'],
                'available': available, 'state': provenance if available else 'unavailable',
                'refreshing': kind in self._busy, 'error': self._errors.get(kind),
                'lastAttemptAt': utc_iso(self._attempts[kind]) if kind in self._attempts else None,
                'refreshSeconds': REFRESH_SECONDS,
                'sourceUrl': 'https://www.earthdata.nasa.gov/data/visualize-data/gibs',
                'licenseNote': 'Public NASA Earth science imagery; retain product and NASA GIBS attribution.',
                'dataType': 'published-satellite-product', 'isInstantaneous': False,
            })
            if available:
                result['imageUrl'] = '/__local/ocean/' + kind + '/image.png?v=' + result['imageSha256'][:16]
                result['legendUrl'] = '/__local/ocean/' + kind + '/legend.png?v=' + result['legendSha256'][:16]
            return result

    def asset_file(self, kind, name, version=None):
        if kind not in PRODUCTS or name not in ('image.png', 'legend.png'):
            return None
        if version is not None and not re.fullmatch(r'[a-f0-9]{16}', version):
            return None
        with self._lock:
            directory = self._active.get(kind)
            metadata = self._records.get(kind, {})
            field = 'imageSha256' if name == 'image.png' else 'legendSha256'
            if directory and (version is None or metadata.get(field, '').startswith(version)):
                return directory / name
            # Metadata previously returned to another tab must retain its exact
            # image even if a newer product is committed in the meantime.
            candidates = [self.snapshots / kind]
            product_directory = self.runtime / kind
            if product_directory.exists():
                candidates.extend(child for child in product_directory.iterdir()
                                  if child.is_dir() and re.fullmatch(r'[a-f0-9]{64}', child.name))
            for candidate in candidates:
                try:
                    record = json.loads((candidate / 'metadata.json').read_text(encoding='utf-8'))
                    if record.get(field, '').startswith(version or ''):
                        path = candidate / name
                        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == record[field]:
                            return path
                except (OSError, ValueError, KeyError, TypeError):
                    pass
            return None

    def refresh(self, kind=None, force=False):
        kinds = tuple(PRODUCTS) if kind is None else (kind,)
        if any(item not in PRODUCTS for item in kinds):
            raise ValueError('Unknown ocean product')
        with self._lock:
            now = time.time()
            for item in kinds:
                metadata = self._records.get(item, {})
                previous = max(self._attempts.get(item, 0),
                               _timestamp(metadata.get('checkedAt'))
                               if self._active.get(item) != self.snapshots / item else 0)
                interval = MIN_REFRESH_SECONDS if force else RETRY_SECONDS if item in self._errors else REFRESH_SECONDS
                if item in self._busy or now - previous < interval:
                    continue
                self._busy.add(item)
                self._attempts[item] = now
                threading.Thread(target=self._refresh_one, args=(item,), daemon=True,
                                 name='atlas-ocean-' + item).start()
        return self.status()

    def _read(self, url, maximum=8 * 1024 * 1024):
        if not url.startswith(ORIGIN + '/'):
            raise ValueError('Ocean provider host is not allowed')
        request = Request(url, headers={'User-Agent': USER_AGENT})
        with build_opener(_ProviderRedirects()).open(request, timeout=25) as response:
            if not response.geturl().startswith(ORIGIN + '/'):
                raise ValueError('Ocean provider redirected outside its allowed host')
            content = response.read(maximum + 1)
            if len(content) > maximum:
                raise ValueError('Ocean provider response exceeds its size limit')
            return content

    def _check_robots(self):
        if time.time() - self._robots_checked < 24 * 3600:
            return
        try:
            text = self._read(ORIGIN + '/robots.txt', maximum=256 * 1024).decode('utf-8')
        except HTTPError as error:
            if error.code not in (404, 410):
                raise
            text = ''
        rules = RobotFileParser()
        rules.parse(text.splitlines())
        if not rules.can_fetch(USER_AGENT, WMS) or not rules.can_fetch(USER_AGENT, ORIGIN + '/legends/'):
            raise ValueError('NASA GIBS robots.txt disallows the required imagery paths')
        self._robots_checked = time.time()

    def _get_capabilities(self):
        with self._cap_lock:
            if self._capabilities and time.time() - self._capabilities['time'] < REFRESH_SECONDS:
                return self._capabilities['products']
            self._check_robots()
            xml = self._read(CAPABILITIES_URL, maximum=5 * 1024 * 1024)
            if b'<!ENTITY' in xml.upper():
                raise ValueError('Unexpected XML entity declaration')
            root = ET.fromstring(xml)
            result = {}
            wanted = {item['layer']: kind for kind, item in PRODUCTS.items()}
            for element in root.iter():
                if element.tag.split('}')[-1] != 'Layer':
                    continue
                name = next((child.text for child in element if child.tag.split('}')[-1] == 'Name'), '')
                if name not in wanted:
                    continue
                dimension = next((child for child in element if child.tag.split('}')[-1] == 'Dimension'
                                  and child.attrib.get('name') == 'time'), None)
                if dimension is None:
                    continue
                dates = available_dates(dimension.text or '')
                if dates:
                    result[wanted[name]] = {'dates': dates, 'defaultDate': dimension.attrib.get('default'),
                                            'checkedAt': utc_iso(), 'capabilitiesUrl': CAPABILITIES_URL}
            if len(result) != len(PRODUCTS):
                raise ValueError('NASA GIBS capabilities are missing an ocean product')
            self._capabilities = {'time': time.time(), 'products': result}
            return result

    def _refresh_one(self, kind):
        try:
            advertised = self._get_capabilities()[kind]
            with self._lock:
                current = dict(self._records.get(kind, {}))
            if current and current.get('validDate') == advertised['dates'][0]:
                current.update(checkedAt=utc_iso(), latestAvailableDate=advertised['dates'][0])
                with self._lock:
                    self._records[kind] = current
                    self._errors.pop(kind, None)
                    self._online.add(kind)
                return
            last_error = None
            for valid_date in advertised['dates']:
                try:
                    url = image_url(kind, valid_date)
                    content = self._read(url)
                    validation = validate_png(content, (WIDTH, HEIGHT), require_data=True)
                    break
                except HTTPError as error:
                    if error.code in (401, 403, 429):
                        raise
                    last_error = error
                except Exception as error:
                    last_error = error
            else:
                raise ValueError('No nonempty recent ocean image was available: ' + str(last_error))
            legend_url = ORIGIN + '/legends/' + PRODUCTS[kind]['legend']
            legend = self._read(legend_url, maximum=1024 * 1024)
            legend_validation = validate_png(legend)
            now = utc_iso()
            metadata = {
                'layer': PRODUCTS[kind]['layer'], 'validDate': valid_date, 'sourceDate': valid_date,
                'latestAvailableDate': advertised['dates'][0], 'fetchedAt': now, 'checkedAt': now,
                'requestUrl': url, 'legendSourceUrl': legend_url,
                'capabilitiesUrl': CAPABILITIES_URL, 'imageSha256': validation['sha256'],
                'legendSha256': legend_validation['sha256'],
                'dimensions': [WIDTH, HEIGHT], 'bbox': [-180, -90, 180, 90], 'crs': 'EPSG:4326',
                'transparentPixels': validation['transparentPixels'],
                'visiblePixels': validation['visiblePixels'],
                'noData': 'transparent; no gap filling or simulated values',
            }
            # Immutable generation files are complete before the pointer and
            # active in-memory record change. Readers never see mixed products.
            product_directory = self.runtime / kind
            generation = hashlib.sha256((metadata['layer'] + valid_date + metadata['imageSha256']
                                         + metadata['legendSha256']).encode('utf-8')).hexdigest()
            directory = product_directory / generation
            _atomic(directory / 'image.png', content)
            _atomic(directory / 'legend.png', legend)
            _atomic(directory / 'metadata.json', json.dumps(metadata, ensure_ascii=False, indent=2).encode('utf-8'))
            _atomic(product_directory / 'current.json', json.dumps({'generation': generation}).encode('utf-8'))
            with self._lock:
                self._records[kind] = metadata
                self._active[kind] = directory
                self._errors.pop(kind, None)
                self._online.add(kind)
            self._prune_generations(kind)
        except Exception as error:
            with self._lock:
                self._online.discard(kind)
                self._errors[kind] = str(error)[:300]
        finally:
            with self._lock:
                self._busy.discard(kind)

    def _prune_generations(self, kind):
        """Retain current/recent immutable generations within this product only."""
        product_directory = (self.runtime / kind).resolve()
        with self._lock:
            active = self._active.get(kind)
            candidates = sorted((child for child in product_directory.iterdir()
                                 if child.is_dir() and re.fullmatch(r'[a-f0-9]{64}', child.name)),
                                key=lambda child: child.stat().st_mtime, reverse=True)
            keep = {child.resolve() for child in candidates[:MAX_GENERATIONS]}
            if active:
                keep.add(active.resolve())
            for child in candidates:
                target = child.resolve()
                # Verify the absolute target remains a known direct generation
                # child before any recursive removal (including on Windows).
                if target.parent != product_directory or target in keep or child.is_symlink():
                    continue
                try:
                    shutil.rmtree(target)
                except OSError:
                    # An image stream open in another request may hold a Windows
                    # file lock. A future bounded refresh can retry cleanup.
                    pass
