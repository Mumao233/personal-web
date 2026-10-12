"""HTTP integration checks using disposable fixtures, never project data.

Run: python -B -m unittest test_server -v
"""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import server


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


class ServerChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_root = server.ROOT
        cls.temp = tempfile.TemporaryDirectory(prefix='solar-atlas-server-check-')
        server.ROOT = Path(cls.temp.name).resolve()
        fixtures = {
            'index.html': b'<!doctype html><title>Root fixture</title>',
            'solar/index.html': b'<!doctype html><title>SPA fixture</title>',
            'solar/assets/module.js': b'export const fixture = true;',
            'data/example.json': b'{"fixture":true}',
            'data/source-error.json': b'<!doctype html><title>Source missing</title>',
            'audio/sample.mp3': bytes(range(256)) * 4,
            'fonts/example.woff2': b'fixture',
            'models/example.glb': b'fixture',
            'wasm/example.wasm': b'fixture',
            'empty.txt': b'',
            'data/music-local-map.json': b'{"123":"audio/sample.mp3"}',
        }
        for name, data in fixtures.items():
            target = server.ROOT / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        cls.fixtures = fixtures
        cls.httpd = server.LocalServer(('127.0.0.1', 0), QuietHandler)
        cls.port = cls.httpd.server_port
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)
        server.ROOT = cls.original_root
        cls.temp.cleanup()

    def request(self, path, method='GET', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_query_does_not_change_file(self):
        status, headers, body = self.request('/solar/assets/module.js?v=20261012')
        self.assertEqual(status, 200)
        self.assertEqual(body, self.fixtures['solar/assets/module.js'])
        self.assertIn('javascript', headers['Content-Type'])
        self.assertEqual(headers['Cache-Control'], 'no-cache')

    def test_mime_types_for_browser_assets(self):
        for path, expected in [('/data/example.json', 'application/json'),
                               ('/audio/sample.mp3', 'audio/mpeg'),
                               ('/fonts/example.woff2', 'font/woff2'),
                               ('/models/example.glb', 'model/gltf-binary'),
                               ('/wasm/example.wasm', 'application/wasm')]:
            with self.subTest(path=path):
                status, headers, _ = self.request(path)
                self.assertEqual(status, 200)
                self.assertTrue(headers['Content-Type'].startswith(expected))

    def test_html_source_error_is_not_labelled_json(self):
        status, headers, _ = self.request('/data/source-error.json')
        self.assertEqual(status, 200)
        self.assertTrue(headers['Content-Type'].startswith('text/html'))

    def test_head_has_no_body(self):
        status, headers, body = self.request('/audio/sample.mp3', 'HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(int(headers['Content-Length']), 1024)
        self.assertEqual(body, b'')

    def test_head_ignores_range_per_http(self):
        status, headers, body = self.request('/audio/sample.mp3', 'HEAD', {'Range': 'bytes=0-3'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Length'], '1024')
        self.assertNotIn('Content-Range', headers)
        self.assertEqual(body, b'')

    def test_ranges_match_real_file_bytes(self):
        data = self.fixtures['audio/sample.mp3']
        for value, start, end in [('bytes=0-7', 0, 7), ('bytes=1000-', 1000, 1023),
                                  ('bytes=-17', 1007, 1023), ('bytes=1010-9999', 1010, 1023),
                                  ('bytes=-9999', 0, 1023)]:
            with self.subTest(range=value):
                status, headers, body = self.request('/audio/sample.mp3', headers={'Range': value})
                self.assertEqual(status, 206)
                self.assertEqual(headers['Content-Range'], f'bytes {start}-{end}/1024')
                self.assertEqual(int(headers['Content-Length']), end - start + 1)
                self.assertEqual(body, data[start:end + 1])

    def test_invalid_ranges_are_empty_416(self):
        for value in ['bytes=1024-', 'bytes=8-2', 'bytes=-0', 'bytes=-',
                      'bytes=0-1,3-4', 'bytes=invalid']:
            with self.subTest(range=value):
                status, headers, body = self.request('/audio/sample.mp3', headers={'Range': value})
                self.assertEqual(status, 416)
                self.assertEqual(headers['Content-Range'], 'bytes */1024')
                self.assertEqual(body, b'')

    def test_if_range_unknown_validator_returns_full_body(self):
        status, _, body = self.request('/audio/sample.mp3', headers={
            'Range': 'bytes=0-7', 'If-Range': '"obsolete"'})
        self.assertEqual(status, 200)
        self.assertEqual(body, self.fixtures['audio/sample.mp3'])

    def test_empty_file(self):
        status, headers, body = self.request('/empty.txt')
        self.assertEqual((status, headers['Content-Length'], body), (200, '0', b''))
        self.assertEqual(self.request('/empty.txt', headers={'Range': 'bytes=0-'})[0], 416)

    def test_legacy_music_alias_and_query(self):
        status, headers, body = self.request('/__external/music.163.com/song/media/outer/url?id=123.mp3',
                                            headers={'Range': 'bytes=0-7'})
        self.assertEqual(status, 206)
        self.assertEqual(body, self.fixtures['audio/sample.mp3'][:8])
        self.assertEqual(headers['Content-Type'], 'audio/mpeg')
        self.assertEqual(self.request('/__external/music.163.com/song/media/outer/url?id=999.mp3')[0], 404)

    def test_directory_redirect_retains_query(self):
        status, headers, body = self.request('/solar?lang=en')
        self.assertEqual(status, 301)
        self.assertEqual(headers['Location'], '/solar/?lang=en')
        self.assertEqual(body, b'')

    def test_spa_refresh_is_limited_to_html_navigation(self):
        status, _, body = self.request('/solar/view/earth', headers={'Accept': 'text/html',
                                                                  'Sec-Fetch-Dest': 'document'})
        self.assertEqual(status, 200)
        self.assertEqual(body, self.fixtures['solar/index.html'])
        self.assertEqual(self.request('/solar/view/earth', headers={'Accept': 'application/json'})[0], 404)
        self.assertEqual(self.request('/solar/view/earth', headers={'Accept': 'text/html',
                                                                  'Sec-Fetch-Dest': 'empty'})[0], 404)

    def test_missing_files_and_api_do_not_receive_spa_shell(self):
        for path in ['/solar/assets/missing.js', '/solar/assets/missing',
                     '/solar/api/orbits', '/api/missing', '/data/missing.json', '/other-page']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path, headers={'Accept': 'text/html'})[0], 404)

    def test_traversal_and_windows_path_forms_rejected(self):
        for path in ['/../server.py', '/%2e%2e/server.py', '/solar/%2e%2e/server.py',
                     '/C:/Windows/win.ini', '/solar%5c..%5cserver.py', '/solar/%00']:
            with self.subTest(path=path):
                self.assertIn(self.request(path)[0], (400, 403))

    def test_no_directory_listing(self):
        self.assertEqual(self.request('/data/')[0], 404)

    def test_status_identifies_the_project(self):
        status, _, body = self.request(server.STATUS_PATH)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['instance_id'], server.INSTANCE_ID)
        self.assertTrue(server.existing_instance(self.port))


if __name__ == '__main__':
    unittest.main(verbosity=2)
