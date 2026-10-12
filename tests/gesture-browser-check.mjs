import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'C:/Users/Mumao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5193';
const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { checks: [], notes: ['Synthetic canvas/video only; no physical camera requested.'] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on('request', req => requests.push(req.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__cameraRequests = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      window.__cameraRequests++; throw new DOMException('Test permission denied', 'NotAllowedError');
    } });
  });
  await page.goto(`${base}/solar/?boot=0&view=atlas&debug=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gesture-trigger').waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#gesture-enabled').isChecked(), false);
  assert.equal(await page.evaluate(() => window.__cameraRequests), 0);
  assert.equal(requests.filter(url => url.includes('/vendor/gesture/') || url.includes('gesture-worker')).length, 0);
  report.checks.push('Default OFF: zero getUserMedia calls and zero WASM/model/worker requests.');
  await page.locator('.gesture-trigger').click();
  await page.locator('#gesture-enabled').click();
  await page.waitForFunction(() => document.querySelector('#gesture-status').textContent.includes('权限未允许'));
  assert.equal(await page.locator('#gesture-enabled').isChecked(), false);
  assert.equal(await page.evaluate(() => window.__cameraRequests), 1);
  assert.equal(requests.filter(url => url.includes('/vendor/gesture/')).length, 0);
  report.checks.push('Permission denied: readable error, OFF restored, no model download.');
  await page.screenshot({ path: 'docs/gesture-control-desktop.png', fullPage: false });
  // Load the actual shipped worker and model against a blank bitmap; this does not use mediaDevices.
  const workerResult = await page.evaluate(async () => {
    const worker = new Worker('/solar/gesture-worker.js');
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker smoke timeout')); }, 60000);
      worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
      worker.onmessage = async ({ data }) => {
        if (data.type === 'ready') {
          const canvas = new OffscreenCanvas(320, 240); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 320, 240);
          const bitmap = canvas.transferToImageBitmap(); worker.postMessage({ type: 'frame', bitmap, timestamp: performance.now() }, [bitmap]);
        } else if (data.type === 'result') { clearTimeout(timer); worker.terminate(); resolve({ type: data.type, hands: data.landmarks.length }); }
        else if (data.type === 'error') { clearTimeout(timer); worker.terminate(); reject(new Error(data.message)); }
      };
      worker.postMessage({ type: 'init' });
    });
  });
  assert.deepEqual(workerResult, { type: 'result', hands: 0 });
  report.checks.push('Actual MediaPipe worker + local WASM + official model initialize and infer blank frame successfully.');
  // Verify the actual camera bridge changes rotation, pan and zoom in the rendered solar scene.
  await page.waitForFunction(() => typeof window.__atlasCamera === 'function');
  const before = await page.evaluate(() => window.__atlasCamera());
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas-gesture', { detail: { action: 'rotate', dx: .035, dy: .02 } })));
  await page.waitForTimeout(800);
  const rotated = await page.evaluate(() => window.__atlasCamera());
  assert.notEqual(rotated.yaw, before.yaw);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas-gesture', { detail: { action: 'pan', dx: .02, dy: .03 } })));
  await page.waitForTimeout(500);
  const panned = await page.evaluate(() => window.__atlasCamera());
  assert.notDeepEqual(panned.offset, rotated.offset);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas-gesture', { detail: { action: 'zoom', scale: 1.2 } })));
  await page.waitForTimeout(700);
  const zoomed = await page.evaluate(() => window.__atlasCamera());
  assert.ok(zoomed.height < panned.height);
  report.checks.push('Rendered scene camera responds to rotate, pan and zoom hand-control bridge.');
  const picked = await page.evaluate(() => {
    const label = [...document.querySelectorAll('.label--planet')].find(item => item.querySelector('.label__text')?.textContent.toLowerCase() === 'jupiter');
    if (!label || label.style.display === 'none') throw new Error('Jupiter target unavailable');
    const matrix = new DOMMatrixReadOnly(label.style.transform);
    let result;
    window.addEventListener('atlas-gesture-result', event => { result = event.detail; }, { once: true });
    window.dispatchEvent(new CustomEvent('atlas-gesture-select', { detail: { x: matrix.m41, y: matrix.m42 } }));
    return { result, focusId: window.__atlasStore.getState().focusId };
  });
  assert.equal(picked.result.selected, true);
  assert.equal(picked.result.id, 'jupiter');
  assert.equal(picked.focusId, 'jupiter');
  report.checks.push('Actual gesture selection bridge picks Jupiter at its rendered screen coordinates.');
  // Exercise the full UI lifecycle using a synthetic canvas stream, never a device stream.
  await page.evaluate(() => {
    window.__syntheticStops = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      window.__cameraRequests++;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 320, 240);
      const stream = canvas.captureStream(10);
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { window.__syntheticStops++; stop(); }; }
      window.__syntheticStream = stream; return stream;
    } });
  });
  await page.locator('#gesture-enabled').click();
  await page.waitForFunction(() => document.querySelector('#gesture-status').textContent.includes('未识别到手'), { timeout: 60000 });
  await page.locator('#gesture-enabled').uncheck();
  assert.equal(await page.evaluate(() => window.__syntheticStops), 1);
  assert.equal(await page.evaluate(() => document.querySelector('.gesture-preview video').srcObject), null);
  assert.equal(await page.evaluate(() => window.__syntheticStream.getTracks()[0].readyState), 'ended');
  report.checks.push('Full switch ON/OFF with synthetic stream: actual local inference runs; OFF stops every track and clears preview.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/gesture-control-mobile.png', fullPage: false });
  const box = await page.locator('#gesture-panel').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  report.checks.push('390px mobile panel stays inside viewport.');
  report.pageErrors = errors;
  assert.equal(errors.filter(e => /gesture|mediapipe|vision_wasm/i.test(e)).length, 0);
  console.log(JSON.stringify(report, null, 2));
  await mkdir('docs', { recursive: true });
  await writeFile('docs/gesture-browser-check.json', JSON.stringify(report, null, 2));
} finally { await browser.close(); }
