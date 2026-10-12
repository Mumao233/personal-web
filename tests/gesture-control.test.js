import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GestureEngine, CameraSession, cameraErrorMessage } from '../atlas/solar/gesture-engine.js';

function hand({ x = .5, y = .5, pinched = true } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  points[5] = { x: x - .08, y: y + .1 }; points[17] = { x: x + .08, y: y + .1 };
  points[0] = { x, y: y + .22 }; points[9] = { x, y: y + .08 };
  points[8] = { x, y }; points[4] = { x: x + (pinched ? .02 : .12), y };
  return points;
}
test('unpinched hand only points, pinch clutches rotation, missing hand releases without jump', () => {
  const engine = new GestureEngine();
  assert.equal(engine.update([hand({ pinched: false })], 0).commands[0].action, 'release');
  assert.equal(engine.update([hand()], 50).commands.length, 0);
  const moved = engine.update([hand({ x: .54 })], 100);
  assert.equal(moved.commands[0].action, 'rotate');
  assert.ok(moved.commands[0].dx < 0, 'mirrored preview and control move together');
  assert.equal(engine.update([], 150).commands[0].action, 'release');
  assert.equal(engine.update([hand({ x: .8 })], 200).commands.length, 0, 'reappearance anchors without moving');
});
test('pan mode updates the scene and rejects jitter / malformed landmarks', () => {
  const engine = new GestureEngine(); engine.setMode('pan');
  engine.update([hand()], 0);
  assert.equal(engine.update([hand({ x: .5001 })], 50).commands.length, 0);
  assert.equal(engine.update([hand({ y: .54 })], 100).commands[0].action, 'pan');
  assert.equal(engine.update([[{ x: NaN, y: 0 }]], 150).kind, 'lost');
});
test('selection requires stable hold, triggers only once, and rearms after release', () => {
  const engine = new GestureEngine(); engine.setMode('select');
  assert.equal(engine.update([hand()], 0).commands.length, 0);
  assert.equal(engine.update([hand()], 500).commands.length, 0);
  assert.equal(engine.update([hand()], 680).commands[0].action, 'select');
  assert.equal(engine.update([hand()], 1500).commands.length, 0);
  engine.update([hand({ pinched: false })], 1600);
  engine.update([hand()], 1700);
  assert.equal(engine.update([hand()], 2400).commands[0].action, 'select');
});
test('moving selection restarts dwell, and losing a hand never selects', () => {
  const engine = new GestureEngine(); engine.setMode('select');
  engine.update([hand()], 0);
  assert.equal(engine.update([hand({ x: .8 })], 680).commands.length, 0);
  assert.equal(engine.update([], 1400).commands.some(c => c.action === 'select'), false);
});
test('two pinched hands scale camera and returning to one hand reanchors', () => {
  const engine = new GestureEngine();
  engine.update([hand({ x: .3 }), hand({ x: .7 })], 0);
  const second = engine.update([hand({ x: .28 }), hand({ x: .72 })], 50);
  assert.equal(second.kind, 'zoom');
  assert.ok(second.commands.some(c => c.action === 'zoom' && c.scale > 1));
  assert.equal(engine.update([hand({ x: .28 })], 100).commands.length, 0);
});
function fixture(overrides = {}) {
  const events = [], stopped = [], frames = [];
  const tracks = [{ stop: () => stopped.push('video'), addEventListener() {} }];
  const video = { readyState: 4, currentTime: 1, play: async () => {}, pause() {}, srcObject: null };
  const tracker = { ready: Promise.resolve(), detect: async () => ({ landmarks: [] }), close: () => events.push('closed') };
  const session = new CameraSession({ video, getUserMedia: async () => ({ getTracks: () => tracks }), createTracker: () => tracker,
    onState: (...state) => events.push(state), onResult: result => events.push(result), requestFrame: fn => { frames.push(fn); return frames.length; }, cancelFrame: id => events.push(['cancelled', id]), ...overrides });
  return { session, video, events, stopped, frames, tracker };
}
test('session remains inactive by construction; explicit start/stop owns all resources', async () => {
  const f = fixture();
  assert.equal(f.session.active, false); assert.equal(f.video.srcObject, null); assert.equal(f.events.length, 0);
  await f.session.start(); assert.equal(f.session.active, true); assert.ok(f.video.srcObject);
  f.session.stop(); assert.equal(f.session.active, false); assert.equal(f.video.srcObject, null);
  assert.deepEqual(f.stopped, ['video']); assert.ok(f.events.includes('closed'));
});
test('late camera approval after OFF stops the newly returned stream and never creates a tracker', async () => {
  let approve; let tracksStopped = 0, trackers = 0;
  const f = fixture({ getUserMedia: () => new Promise(resolve => { approve = resolve; }), createTracker: () => { trackers++; } });
  const pending = f.session.start(); f.session.stop();
  approve({ getTracks: () => [{ stop: () => tracksStopped++ }] }); await pending;
  assert.equal(tracksStopped, 1); assert.equal(trackers, 0); assert.equal(f.session.active, false);
});
test('denied permission ends with readable error and no active session', async () => {
  const error = new Error(); error.name = 'NotAllowedError';
  const f = fixture({ getUserMedia: async () => { throw error; } });
  await f.session.start(); assert.equal(f.session.active, false);
  assert.equal(f.events.at(-1)[0], 'error'); assert.match(f.events.at(-1)[1], /权限/);
  assert.match(cameraErrorMessage({ name: 'NotFoundError' }), /没有找到摄像头/);
});
test('model failure stops the acquired stream, and inference failure also disposes the tracker', async () => {
  const init = fixture({ createTracker: () => ({ ready: Promise.reject(new Error('bad model')), close() {} }) });
  await init.session.start(); assert.deepEqual(init.stopped, ['video']); assert.equal(init.session.active, false);
  const f = fixture(); f.tracker.detect = async () => { throw new Error('lost worker'); };
  await f.session.start(); await f.frames[0](100);
  assert.equal(f.session.active, false); assert.deepEqual(f.stopped, ['video']); assert.ok(f.events.includes('closed'));
});
test('stopping during pending inference prevents result application and further frames', async () => {
  const f = fixture(); let finish;
  f.tracker.detect = () => new Promise(resolve => { finish = resolve; });
  await f.session.start(); const pending = f.frames[0](100); f.session.stop();
  finish({ landmarks: [hand()] }); await pending;
  assert.equal(f.events.some(event => event?.landmarks), false); assert.equal(f.frames.length, 1);
});
