import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, globalAgent } from 'node:http';
import express from 'express';
import { startAtlas } from '../server/atlas-gateway.js';

let atlas, server, fixture;
before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'personal-atlas-refresh-test-'));
  // Only replace upstream service operations in the child. The real Python
  // request parser/handler and Node gateway run unchanged, with no downloads.
  await writeFile(join(fixture, 'sitecustomize.py'), `
import os, sys
sys.path.insert(0, os.getcwd())
import server
class OfflineService:
    def refresh(self, force=True):
        return {'testFixture': True}
for name in ('weather', 'ocean', 'currents'):
    setattr(server.LocalServer, name, property(lambda self: OfflineService()))
`, 'utf8');
  const previous = process.env.PYTHONPATH;
  process.env.PYTHONPATH = fixture;
  try { atlas = await startAtlas(); }
  finally {
    if (previous === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previous;
  }
  const app = express();
  app.use(atlas.middleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise(ok => server.once('listening', ok));
});
after(async () => {
  atlas?.stop();
  if (server) {
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
  }
  globalAgent.destroy();
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

function send(method, path, body = '') {
  return new Promise((ok, fail) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => ok({ status: res.statusCode, text }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

test('refresh request bodies leave reused gateway connections ready for the next request', async () => {
  for (const name of ['weather', 'ocean', 'currents']) {
    const post = await send('POST', `/__local/${name}/refresh`, '{}');
    assert.equal(post.status, 200, name);
    assert.equal(JSON.parse(post.text).testFixture, true);
    // Let the Node Agent return the upstream socket to its free connection
    // pool before the next request, reproducing the original 501 regression.
    await new Promise(ok => setImmediate(ok));
    const next = await send('GET', '/__local/status');
    assert.equal(next.status, 200, name);
    assert.equal(JSON.parse(next.text).application, 'solar-system-atlas');
  }
});
