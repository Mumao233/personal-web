/**
 * Elliptic comet geometry for the saved Atlas.
 * Legacy comet `peri` is argument of perihelion (omega), not the planetary
 * longitude of perihelion. All vectors use the Atlas x/y-up/z convention.
 * The saved elements and assumed year-2000 mean-anomaly epoch are illustrative;
 * these functions do not turn them into a current high-precision ephemeris.
 */
const TAU = 2 * Math.PI;
const RAD = Math.PI / 180;

function finite(value, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

export function normalizeMeanAnomaly(value) {
  finite(value, 'mean anomaly');
  let result = value % TAU;
  if (result > Math.PI) result -= TAU;
  if (result < -Math.PI) result += TAU;
  return result;
}

export function solveKepler(meanAnomaly, eccentricity) {
  const e = finite(eccentricity, 'eccentricity');
  if (e < 0 || e >= 1) throw new RangeError('This module requires 0 <= e < 1');
  const M = normalizeMeanAnomaly(meanAnomaly);
  if (M === 0 || e === 0) return M;
  let lower = -Math.PI;
  let upper = Math.PI;
  let E = e < 0.8 ? M : Math.sign(M) * Math.PI;
  // Newton is accepted only inside the known monotonic root bracket.
  // Otherwise bisection guarantees progress even for near-parabolic ellipses.
  for (let iteration = 0; iteration < 96; iteration += 1) {
    const residual = E - e * Math.sin(E) - M;
    if (Math.abs(residual) <= 2e-14) return E;
    if (residual < 0) lower = E; else upper = E;
    const candidate = E - residual / (1 - e * Math.cos(E));
    E = Number.isFinite(candidate) && candidate > lower && candidate < upper
      ? candidate : (lower + upper) / 2;
  }
  throw new Error('Elliptic Kepler solver did not converge');
}

export function cometState(comet, year) {
  finite(year, 'year');
  if (!(comet.a > 0) || !(comet.periodYears > 0)) throw new RangeError('Invalid comet orbit');
  const epochYear = comet.epochYear ?? 2000;
  const M = normalizeMeanAnomaly((comet.m0 + 360 * (year - epochYear) / comet.periodYears) * RAD);
  const E = solveKepler(M, comet.e);
  const rAu = comet.a * (1 - comet.e * Math.cos(E));
  const nu = Math.atan2(Math.sqrt(1 - comet.e * comet.e) * Math.sin(E), Math.cos(E) - comet.e);
  return { nu, rAu, eccentricAnomaly: E, meanAnomaly: M };
}

/** Rotation only, with a single constant scale for the whole orbit. */
export function orbitalPlanePoint(comet, x, y, scale = 1) {
  const node = comet.node * RAD;
  const omega = (comet.argumentOfPerihelion ?? comet.peri) * RAD;
  const inclination = comet.i * RAD;
  const X = x * Math.cos(omega) - y * Math.sin(omega);
  const Y = x * Math.sin(omega) + y * Math.cos(omega);
  return [
    scale * (Math.cos(node) * X - Math.sin(node) * Math.cos(inclination) * Y),
    scale * Math.sin(inclination) * Y,
    scale * (Math.sin(node) * X + Math.cos(node) * Math.cos(inclination) * Y),
  ];
}

export function orbitPoint(comet, rAu, trueAnomaly, scale = 1) {
  return orbitalPlanePoint(comet, rAu * Math.cos(trueAnomaly), rAu * Math.sin(trueAnomaly), scale);
}

export function orbitSample(comet, segments = 960, scale = 1) {
  if (!Number.isInteger(segments) || segments < 8) throw new RangeError('At least eight segments required');
  solveKepler(0, comet.e);
  const b = comet.a * Math.sqrt(1 - comet.e * comet.e);
  const points = [];
  for (let index = 0; index < segments; index += 1) {
    const E = index / segments * TAU;
    points.push(orbitalPlanePoint(comet, comet.a * (Math.cos(E) - comet.e), b * Math.sin(E), scale));
  }
  points.push([...points[0]]); // exact closure, no final floating-point seam
  return points;
}

export function orbitCenter(comet, scale = 1) {
  return orbitalPlanePoint(comet, -comet.a * comet.e, 0, scale);
}

function dot(a, b) { return a.reduce((sum, value, index) => sum + value * b[index], 0); }

/** Face the orbital plane and fit its projected bounds around the sidebar/sheet. */
export function orbitFrame(comet, scale, aspect, widthFraction = 0.58, heightFraction = 0.82) {
  if (!(aspect > 0) || !(scale > 0)) throw new RangeError('Invalid camera frame');
  const u = orbitalPlanePoint(comet, 1, 0);
  const v = orbitalPlanePoint(comet, 0, 1);
  let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  if (normal[1] < 0) normal = normal.map(value => -value);
  const yaw = Math.atan2(normal[0], normal[2]);
  // A tiny tilt at an exactly ecliptic orbit keeps the camera up-vector defined.
  const pitch = Math.min(Math.PI / 2 - 1e-4, Math.asin(Math.max(-1, Math.min(1, normal[1]))));
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [-Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.cos(yaw)];
  const center = orbitCenter(comet, scale);
  let halfWidth = 0;
  let halfHeight = 0;
  for (const point of orbitSample(comet, 960, scale)) {
    const relative = point.map((value, index) => value - center[index]);
    halfWidth = Math.max(halfWidth, Math.abs(dot(relative, right)));
    halfHeight = Math.max(halfHeight, Math.abs(dot(relative, up)));
  }
  const height = Math.max(2 * halfHeight / heightFraction, 2 * halfWidth / (aspect * widthFraction), 12) * 1.12;
  return { center, height, yaw, pitch, halfWidth, halfHeight };
}
