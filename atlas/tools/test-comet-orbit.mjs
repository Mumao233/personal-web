import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeMeanAnomaly, solveKepler, cometState, orbitalPlanePoint,
  orbitPoint, orbitSample, orbitCenter, orbitFrame,
} from '../solar/assets/comet-orbit.mjs';

const bundle = readFileSync(new URL('../solar/assets/solar.js', import.meta.url), 'utf8');
const source = bundle.slice(bundle.indexOf('Id=[{'), bundle.indexOf('],zT=new Map'));
const comets = [...source.matchAll(/\{id:"([^"]+)",name:"[^"]+",nameCn:"[^"]+",a:([^,]+),e:([^,]+),i:([^,]+),node:([^,]+),peri:([^,]+),m0:([^,]+),periodYears:([^,]+),/g)]
  .map(match => ({ id: match[1], ...Object.fromEntries(['a', 'e', 'i', 'node', 'peri', 'm0', 'periodYears'].map((key, index) => [key, Number(match[index + 2])])) }));
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const subtract = (a, b) => a.map((value, index) => value - b[index]);

function distanceToSegment(point, a, b) {
  const edge = subtract(b, a);
  const lengthSquared = dot(edge, edge);
  const fraction = Math.max(0, Math.min(1, dot(subtract(point, a), edge) / lengthSquared));
  return distance(point, a.map((value, index) => value + fraction * edge[index]));
}

test('tests use all five comet records from the actual rendered bundle', () => {
  assert.deepEqual(comets.map(comet => comet.id), ['halley', '67p', 'encke', 'hale-bopp', 'wild-2']);
  assert.ok(comets.every(comet => comet.e >= 0 && comet.e < 1));
});

for (const comet of comets) {
  test(`${comet.id}: closed ellipse with Sun at a focus and constant geometry`, () => {
    const scale = 17;
    const points = orbitSample(comet, 960, scale);
    assert.deepEqual(points[0], points.at(-1));
    const center = orbitCenter(comet, scale);
    const secondFocus = center.map(value => value * 2);
    const u = orbitalPlanePoint(comet, 1, 0);
    const v = orbitalPlanePoint(comet, 0, 1);
    const a = comet.a * scale;
    const b = a * Math.sqrt(1 - comet.e ** 2);
    for (const point of points) {
      assert.ok(Math.abs(distance(point, [0, 0, 0]) + distance(point, secondFocus) - 2 * a) < a * 2e-12);
      const relative = subtract(point, center);
      const conic = (dot(relative, u) / a) ** 2 + (dot(relative, v) / b) ** 2;
      assert.ok(Math.abs(conic - 1) < 2e-12);
    }
  });

  test(`${comet.id}: moving marker stays on the rendered polyline and repeats its period`, () => {
    const scale = 13;
    const points = orbitSample(comet, 960, scale);
    const center = orbitCenter(comet, scale);
    const secondFocus = center.map(value => value * 2);
    for (const year of [1957, 1986, 2000, 2026, 2026.78, 2061, 2100]) {
      const state = cometState(comet, year);
      const position = orbitPoint(comet, state.rAu, state.nu, scale);
      assert.ok(Math.abs(state.eccentricAnomaly - comet.e * Math.sin(state.eccentricAnomaly) - state.meanAnomaly) < 3e-13);
      assert.ok(Math.abs(distance(position, [0, 0, 0]) + distance(position, secondFocus) - 2 * comet.a * scale) < comet.a * scale * 2e-12);
      const separation = Math.min(...points.slice(1).map((point, index) => distanceToSegment(position, points[index], point)));
      assert.ok(separation < comet.a * scale * 6e-6, `marker/polyline separation ${separation}`);
      const later = cometState(comet, year + comet.periodYears);
      assert.ok(Math.abs(later.rAu - state.rAu) < comet.a * 1e-10);
    }
  });

  test(`${comet.id}: desktop and portrait frames contain the full orbit outside the UI reserve`, () => {
    for (const [aspect, widthFraction, heightFraction] of [[16 / 9, 0.58, 0.62], [390 / 844, 0.88, 0.36]]) {
      const scale = 300 / comet.a;
      const frame = orbitFrame(comet, scale, aspect, widthFraction, heightFraction);
      assert.ok(frame.height < 6000);
      const right = [Math.cos(frame.yaw), 0, -Math.sin(frame.yaw)];
      const up = [-Math.sin(frame.pitch) * Math.sin(frame.yaw), Math.cos(frame.pitch), -Math.sin(frame.pitch) * Math.cos(frame.yaw)];
      for (const point of orbitSample(comet, 1920, scale)) {
        const relative = subtract(point, frame.center);
        assert.ok(Math.abs(dot(relative, right)) < frame.height * aspect * widthFraction / 2);
        assert.ok(Math.abs(dot(relative, up)) < frame.height * heightFraction / 2);
      }
    }
  });
}

test('peri is argument of perihelion; ascending node is not subtracted twice', () => {
  const point = orbitalPlanePoint({ node: 90, peri: 30, i: 0 }, 1, 0);
  assert.ok(distance(point, [-0.5, 0, Math.sqrt(3) / 2]) < 1e-14);
  const inclined = orbitalPlanePoint({ node: 0, argumentOfPerihelion: 90, i: 90 }, 1, 0);
  assert.ok(distance(inclined, [0, 1, 0]) < 1e-14);
});

test('Kepler convergence near perihelion, at many revolutions, and near e = 1', () => {
  for (const e of [0, 0.641, 0.8483, 0.96714, 0.9951, 0.9999999]) {
    for (const M of [-1e6, -Math.PI, -0.3, -1e-9, 0, 1e-12, 0.3, Math.PI / 2, Math.PI, 1e6]) {
      const E = solveKepler(M, e);
      assert.ok(Number.isFinite(E));
      assert.ok(Math.abs(E - e * Math.sin(E) - normalizeMeanAnomaly(M)) < 3e-13);
    }
  }
  assert.throws(() => solveKepler(1, 1), /0 <= e < 1/);
  assert.throws(() => solveKepler(Infinity, 0.5), /finite/);
});

test('Hale-Bopp 2026 regression: six unconstrained Newton iterations no longer diverge', () => {
  const state = cometState(comets.find(comet => comet.id === 'hale-bopp'), 2026);
  assert.ok(Math.abs(state.rAu - 123.47811185515015) < 1e-9);
});

test('the actual scene, marker and focus use the new module and gesture cleanup is present', () => {
  assert.ok(bundle.startsWith('import {cometState as atlasCometState'));
  assert.ok(bundle.includes('return atlasCometState(t,e)'));
  assert.ok(bundle.includes('i.set(...atlasCometPoint(t,e,n,atlasCometScale(t)))'));
  assert.ok(bundle.includes('return atlasCometSample(t,e,atlasCometScale(t)).map'));
  assert.ok(bundle.includes('function UT(t,e,n=new z){return Dae(t,e,n)}'));
  assert.ok(bundle.includes('e.current.visible=t;e.current.scale.setScalar(1)'));
  assert.ok(bundle.includes('cometFocusMode:"ORBIT"'));
  assert.ok(bundle.includes('window.removeEventListener("atlas-gesture",gestureCamera)'));
  assert.ok(bundle.includes('window.removeEventListener("atlas-gesture-select",gestureSelect)'));
});
