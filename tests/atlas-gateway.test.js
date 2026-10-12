import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { isAtlasRequest } from '../server/atlas-gateway.js';

let child, dir, base;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'personal-atlas-test-'));
  const reserve = createServer();
  await new Promise(ok => reserve.listen(0, '127.0.0.1', ok));
  const port = reserve.address().port;
  await new Promise(ok => reserve.close(ok));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js', '--production'], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), TEST_MODE: '1', ATLAS_ENABLED: '1' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', b => { logs += b; });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/status')).ok) return; } catch {}
    if (child.exitCode !== null) throw Error(logs);
    await new Promise(ok => setTimeout(ok, 100));
  }
  throw Error('Gateway did not start: ' + logs);
});
after(async () => {
  // /api/__test/shutdown is not exposed: close stdin to ask the owned process
  // to stop cleanly so its private Python child is also collected.
  if (child && child.exitCode === null) {
    child.stdin.end();
    await new Promise(ok => child.once('exit', ok));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('routes share one origin without exposing personal storage', async () => {
  assert.equal(isAtlasRequest('/?page=world'), false);
  assert.equal(isAtlasRequest('/?view=globe&from=solar'), true);
  assert.equal(isAtlasRequest('/api/public'), false);
  assert.equal(isAtlasRequest('/api/environment/weather.json'), true);
  const personal = await fetch(base + '/api/public');
  assert.equal(personal.status, 200);
  assert.equal((await personal.json()).profile.name, '林珈诚');
  assert.equal(personal.headers.get('x-atlas-live-weather'), '1');
  for (const path of ['/solar/', '/?view=globe', '/?view=depth', '/?view=map']) {
    const page = await fetch(base + path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await fetch(base + '/data/space.sqlite')).status, 404);
  assert.equal((await fetch(base + '/server/index.js')).status, 404);
  assert.equal((await fetch(base + '/solar/assets/missing.js')).status, 404);
});
test('gateway preserves Atlas byte ranges, HEAD and same-origin write protection', async () => {
  const partial = await fetch(base + '/audio/music/ether.mp3', { headers: { Range: 'bytes=0-31' } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 32);
  assert.match(partial.headers.get('content-range'), /^bytes 0-31\//);
  const head = await fetch(base + '/solar/assets/solar.css', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  const denied = await fetch(base + '/__local/weather/refresh', { method: 'POST', headers: { Origin: 'https://unrelated.example' } });
  assert.equal(denied.status, 403);
  const status = await fetch(base + '/__local/status');
  assert.equal((await status.json()).application, 'solar-system-atlas');
});
