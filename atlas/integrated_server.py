"""Private loopback sidecar owned by the Personal Web Node gateway."""
import json
import sys
from server import Handler, LocalServer


class IntegratedHandler(Handler):
    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            # Normal when a browser leaves a scene with pending texture/audio requests.
            pass

    def log_message(self, fmt, *args):
        # Avoid thousands of tile access lines; preserve server errors.
        if args and isinstance(args[0], str) and args[0].startswith('code '):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    server = LocalServer(('127.0.0.1', 0), IntegratedHandler)
    print(json.dumps({'application': 'personal-web-atlas', 'port': server.server_port}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
