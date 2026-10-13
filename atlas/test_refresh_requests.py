"""Refresh framing regression checks with fake services and no network refresh."""
import http.client
import socket
import threading
import unittest
from unittest.mock import Mock, patch

import server


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


class RefreshRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.LocalServer(('127.0.0.1', 0), QuietHandler)
        for name in ('weather', 'ocean', 'currents'):
            setattr(cls.httpd, '_' + name, Mock(refresh=Mock(return_value={'fixture': name})))
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=3)

    def setUp(self):
        for name in ('weather', 'ocean', 'currents'):
            getattr(self.httpd, '_' + name).refresh.reset_mock()

    def connection(self):
        return http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=3)

    def test_json_post_does_not_contaminate_the_next_keep_alive_get(self):
        for name in ('weather', 'ocean', 'currents'):
            with self.subTest(service=name):
                connection = self.connection()
                try:
                    for body in (b'{}', b'x' * server.MAX_REFRESH_BODY_BYTES, b''):
                        connection.request('POST', '/__local/' + name + '/refresh', body=body)
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        response.read()
                        sock = connection.sock
                        connection.request('GET', '/__local/status')
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        response.read()
                        self.assertIs(connection.sock, sock)
                finally:
                    connection.close()
                self.assertEqual(getattr(self.httpd, '_' + name).refresh.call_count, 3)

    def test_bad_framing_is_rejected_and_closed_without_refresh(self):
        cases = [([('Content-Length', '-1')], 400),
                 ([('Content-Length', '+2')], 400),
                 ([('Content-Length', 'not-a-number')], 400),
                 ([('Content-Length', '2'), ('Content-Length', '2')], 400),
                 ([('Content-Length', '4097')], 413),
                 ([('Content-Length', '9' * 1000)], 413),
                 ([('Transfer-Encoding', 'chunked')], 400),
                 ([('Transfer-Encoding', 'chunked'), ('Content-Length', '2')], 400)]
        for name in ('weather', 'ocean', 'currents'):
            for headers, expected in cases:
                with self.subTest(service=name, headers=headers):
                    connection = self.connection()
                    try:
                        connection.putrequest('POST', '/__local/' + name + '/refresh')
                        for key, value in headers:
                            connection.putheader(key, value)
                        connection.endheaders()
                        response = connection.getresponse()
                        self.assertEqual(response.status, expected)
                        self.assertEqual(response.getheader('Connection'), 'close')
                        response.read()
                        self.assertIsNone(connection.sock)
                    finally:
                        connection.close()
            getattr(self.httpd, '_' + name).refresh.assert_not_called()

    def test_incomplete_body_is_rejected_without_refresh(self):
        connection = self.connection()
        try:
            connection.putrequest('POST', '/__local/weather/refresh')
            connection.putheader('Content-Length', '2')
            connection.endheaders(b'{')
            connection.sock.shutdown(socket.SHUT_WR)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(response.getheader('Connection'), 'close')
            response.read()
        finally:
            connection.close()
        self.httpd._weather.refresh.assert_not_called()

    def test_stalled_body_times_out_without_refresh(self):
        connection = self.connection()
        try:
            with patch.object(server, 'REFRESH_BODY_TIMEOUT_SECONDS', 0.05):
                connection.putrequest('POST', '/__local/weather/refresh')
                connection.putheader('Content-Length', '2')
                connection.endheaders()
                response = connection.getresponse()
                self.assertEqual(response.status, 408)
                self.assertEqual(response.getheader('Connection'), 'close')
                response.read()
        finally:
            connection.close()
        self.httpd._weather.refresh.assert_not_called()


if __name__ == '__main__':
    unittest.main()
