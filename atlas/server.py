"""Local atlas server with optional public forecasts; Python 3.9+ standard library.

Run python server.py --open, or double-click start.bat on Windows.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from weather_live import WeatherLive
from ocean_services import OceanServices
from terrain_service import TerrainService
from currents_service import CurrentsService

ROOT = Path(__file__).resolve().parent
INSTANCE_ID = hashlib.sha256(os.path.normcase(str(ROOT)).encode('utf-8')).hexdigest()
STATUS_PATH = '/__local/status'
MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.wasm': 'application/wasm', '.gltf': 'model/gltf+json',
    '.glb': 'model/gltf-binary', '.hdr': 'image/vnd.radiance',
}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    # Globe tiles and weather chunks can arrive in bursts from several tabs.
    request_queue_size = 128
    # On Windows, reusing a live socket can steal traffic from another process.
    allow_reuse_address = os.name != 'nt'

    @property
    def weather(self):
        if not hasattr(self, '_weather'):
            with WEATHER_INIT_LOCK:
                if not hasattr(self, '_weather'):
                    self._weather = WeatherLive(ROOT)
        return self._weather

    @property
    def ocean(self):
        with WEATHER_INIT_LOCK:
            if not hasattr(self, '_ocean'):
                self._ocean = OceanServices(ROOT)
        return self._ocean

    @property
    def terrain(self):
        with WEATHER_INIT_LOCK:
            if not hasattr(self, '_terrain'):
                self._terrain = TerrainService(ROOT)
        return self._terrain

    @property
    def currents(self):
        with WEATHER_INIT_LOCK:
            if not hasattr(self, '_currents'):
                self._currents = CurrentsService(ROOT)
        return self._currents


WEATHER_INIT_LOCK = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    server_version = 'SolarSystemAtlasLocal/3.0'
    # All responses carry a length; reuse connections during globe tile bursts.
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        self._remaining = None
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Revalidate editable local files instead of retaining an older build.
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Atlas-Live-Weather', '1')
        super().end_headers()

    def _json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        return None

    def do_POST(self):
        if self.path not in ('/__local/weather/refresh', '/__local/ocean/refresh', '/__local/currents/refresh'):
            self.send_error(404, 'Unknown local action')
            return
        origin = self.headers.get('Origin')
        expected = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}
        if origin and origin not in expected:
            self.send_error(403, 'Weather updates require the local atlas origin')
            return
        service = self.server.ocean if self.path == '/__local/ocean/refresh' else self.server.currents if self.path == '/__local/currents/refresh' else self.server.weather
        self._json(service.refresh(force=True))

    def guess_type(self, path):
        suffix = Path(path).suffix.lower()
        return MIME_TYPES.get(suffix) or mimetypes.guess_type(str(path))[0] or 'application/octet-stream'

    def _safe_target(self, path):
        try:
            decoded = unquote(path, errors='strict')
        except UnicodeError:
            self.send_error(400, 'Invalid URL encoding')
            return None
        if '\x00' in decoded or '\\' in decoded or ':' in decoded:
            self.send_error(400, 'Invalid local path')
            return None
        if '..' in PurePosixPath(decoded).parts:
            self.send_error(403, 'Path is outside the project')
            return None
        try:
            target = (ROOT / decoded.lstrip('/')).resolve()
            target.relative_to(ROOT)
        except (OSError, ValueError):
            self.send_error(403, 'Path is outside the project')
            return None
        return target

    def _serve_file(self, target):
        try:
            target = target.resolve()
            target.relative_to(ROOT)
        except (OSError, ValueError):
            self.send_error(403, 'Path is outside the project')
            return None
        try:
            stream = target.open('rb')
            info = os.fstat(stream.fileno())
        except (OSError, ValueError):
            self.send_error(404, 'Local file not found')
            return None

        size = info.st_size
        content_type = self.guess_type(target)
        # Some unavailable source JSON/API URLs returned an HTML shell.
        # Identify those archived responses honestly instead of calling them JSON.
        if target.suffix.lower() == '.json' or not target.suffix:
            prefix = stream.read(256).lstrip(b'\xef\xbb\xbf \r\n\t').lower()
            stream.seek(0)
            if prefix.startswith((b'<!doctype html', b'<html')):
                content_type = MIME_TYPES['.html']

        start, end, status = 0, size - 1, 200
        range_header = self.headers.get('Range') if self.command == 'GET' else None
        # Unknown If-Range validators require the whole representation.
        if range_header and not self.headers.get('If-Range'):
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header.strip())
            valid = bool(match and any(match.groups()) and size)
            if valid:
                left, right = match.groups()
                if left:
                    start = int(left)
                    end = min(int(right), size - 1) if right else size - 1
                else:
                    suffix_length = int(right)
                    start = max(0, size - suffix_length)
                valid = start < size and end >= start
            if not valid:
                stream.close()
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()
                return None
            status = 206

        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('Last-Modified', self.date_time_string(info.st_mtime))
        self.send_header('Accept-Ranges', 'bytes')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        stream.seek(start)
        self._remaining = length
        return stream

    def _music_target(self, parsed):
        song_id = parse_qs(parsed.query).get('id', [''])[0].removesuffix('.mp3')
        try:
            mapping = json.loads((ROOT / 'data/music-local-map.json').read_text(encoding='utf-8-sig'))
            relative = mapping.get(song_id)
            target = (ROOT / relative).resolve() if isinstance(relative, str) else None
            if target is not None:
                target.relative_to(ROOT)
                if target.is_file():
                    return target
        except (OSError, ValueError, TypeError):
            pass
        self.send_error(404, 'This music track was not captured for offline playback')
        return None

    def send_head(self):
        self._remaining = None
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self.send_error(400, 'Invalid URL')
            return None
        if parsed.path == STATUS_PATH:
            return self._json({'application': 'solar-system-atlas', 'version': 3,
                               'instance_id': INSTANCE_ID, 'capabilities': {'live_weather': True,
                               'ocean_imagery': True, 'terrain': True, 'reference_layers': True,
                               'geostrophic_currents': True}})

        if parsed.path.startswith('/__local/currents/'):
            service = self.server.currents
            if parsed.path == '/__local/currents/status':
                return self._json(service.status())
            if parsed.path == '/__local/currents/manifest.json':
                offline = parse_qs(parsed.query).get('offline') == ['1']
                return self._json(service.manifest(auto_refresh=not offline and self.command != 'HEAD'))
            if parsed.path.startswith('/__local/currents/files/'):
                target = service.asset_path(parsed.path.removeprefix('/__local/currents/files/'))
                if target is not None:
                    return self._serve_file(target)
            return self._json({'error': 'Current resource unavailable'}, 404)

        if parsed.path.startswith('/__local/ocean/'):
            service = self.server.ocean
            if parsed.path == '/__local/ocean/status':
                return self._json(service.status())
            match = re.fullmatch(r'/__local/ocean/(sst|salinity|chlorophyll)/(metadata|image\.png|legend\.png)', parsed.path)
            if match:
                kind, asset = match.groups()
                if asset == 'metadata':
                    offline = parse_qs(parsed.query).get('offline') == ['1']
                    return self._json(service.metadata(kind, refresh=not offline and self.command != 'HEAD'))
                target = service.asset_file(kind, asset, version=parse_qs(parsed.query).get('v', [None])[0])
                if target is not None:
                    return self._serve_file(target)
            return self._json({'error': 'Ocean resource unavailable'}, 404)

        if parsed.path.startswith('/__local/terrain/'):
            if parsed.path == '/__local/terrain/status':
                return self._json(self.server.terrain.status())
            match = re.fullmatch(r'/__local/terrain/(\d{1,2})/(\d{1,5})/(\d{1,5})\.png', parsed.path)
            if match:
                try:
                    offline = parse_qs(parsed.query).get('offline') == ['1']
                    target = self.server.terrain.tile_path(*map(int, match.groups()), online=not offline and self.command != 'HEAD')
                except ValueError:
                    return self._json({'error': 'Invalid terrain coordinates'}, 400)
                if target is not None:
                    return self._serve_file(target)
                # Absence is explicit; the client retains the ellipsoid for this tile.
                self.send_response(204)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
            return self._json({'error': 'Terrain resource unavailable'}, 404)

        if parsed.path.startswith('/__local/weather/'):
            service = self.server.weather
            if parsed.path == '/__local/weather/status':
                return self._json(service.status())
            if parsed.path == '/__local/weather/gfs-surface.json':
                offline = parse_qs(parsed.query).get('offline') == ['1']
                return self._json(service.manifest(auto_refresh=not offline and self.command != 'HEAD'))
            if parsed.path == '/__local/weather/refresh':
                return self._json({'error': 'Use POST to refresh'}, 405)
            if parsed.path.startswith('/__local/weather/chunks/'):
                target = service.asset_path(parsed.path.removeprefix('/__local/weather/chunks/'))
            else:
                target = service.full_grid_path(parsed.path.removeprefix('/__local/weather/'))
            if target is not None:
                return self._serve_file(target)
            self.send_error(404, 'Weather resource not found')
            return None

        if parsed.path == '/__external/music.163.com/song/media/outer/url':
            target = self._music_target(parsed)
            return self._serve_file(target) if target is not None else None
        if parsed.path.startswith('/__external/'):
            self.send_error(404, 'External resource was not archived')
            return None

        target = self._safe_target(parsed.path)
        if target is None:
            return None
        if target.is_dir():
            if not parsed.path.endswith('/'):
                self.send_response(301)
                # A relative Location cannot redirect to a different host.
                location = quote('/' + unquote(parsed.path).lstrip('/') + '/', safe='/')
                if parsed.query:
                    location += '?' + parsed.query
                self.send_header('Location', location)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
            target = target / 'index.html'
            if not target.is_file():
                self.send_error(404, 'Directory listing is disabled')
                return None
        elif not target.is_file():
            # Restrict shell fallback to actual HTML navigation in the SPA.
            # Missing assets, JSON, API, and fetch() calls must remain honest 404s.
            decoded_path = unquote(parsed.path)
            accept = self.headers.get('Accept', '')
            destination = self.headers.get('Sec-Fetch-Dest', '')
            relative_parts = PurePosixPath(decoded_path).parts[2:]
            is_spa_navigation = (
                decoded_path.startswith('/solar/')
                and 'text/html' in accept
                and destination in ('', 'document', 'iframe')
                and relative_parts
                and relative_parts[0] not in ('assets', 'api', 'data')
                and not any('.' in part for part in relative_parts)
            )
            if not is_spa_navigation:
                self.send_error(404, 'Local resource not found')
                return None
            target = ROOT / 'solar/index.html'
        return self._serve_file(target)

    def copyfile(self, source, outputfile):
        remaining = self._remaining
        try:
            while remaining:
                block = source.read(min(64 * 1024, remaining))
                if not block:
                    break
                outputfile.write(block)
                remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Browsers cancel requests normally when seeking or navigating.
            pass


def existing_instance(port):
    """Identify this exact project without using system proxy configuration."""
    try:
        request = Request(f'http://127.0.0.1:{port}{STATUS_PATH}', headers={'Accept': 'application/json'})
        with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
            status = json.loads(response.read(4096))
        return (isinstance(status, dict)
                and status.get('application') == 'solar-system-atlas'
                and status.get('instance_id') == INSTANCE_ID
                and status.get('version') == 3)
    except (OSError, ValueError, HTTPError, URLError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=os.environ.get('SOLAR_ATLAS_PORT', '8766'))
    parser.add_argument('--open', action='store_true', help='Open the local atlas in your default browser')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    url = f'http://127.0.0.1:{args.port}/solar/'
    try:
        server = LocalServer(('127.0.0.1', args.port), Handler)
    except OSError as error:
        if existing_instance(args.port):
            print(f'This project is already running: {url}', flush=True)
            if args.open:
                webbrowser.open(url)
            return 0
        print(f'Cannot use local port {args.port}: {error}', file=sys.stderr)
        print('No process was stopped. Choose another port, for example:', file=sys.stderr)
        print('  python server.py --port 8766 --open', file=sys.stderr)
        return 1

    print(f'Solar System Atlas: {url}', flush=True)
    print('Keep this window open. Press Ctrl+C to stop the server.', flush=True)
    if args.open:
        timer = threading.Timer(0.25, webbrowser.open, args=(url,))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
