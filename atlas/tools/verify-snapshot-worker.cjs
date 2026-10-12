#!/usr/bin/env node
'use strict';

// Run with: node tools/verify-snapshot-worker.cjs
// Uses only Node built-ins. Executes the real worker and archived orbital data
// with controlled clocks; never alters orbital elements or archive metadata.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'evidence', 'snapshot-worker-validation.json');
const workerCode = fs.readFileSync(path.join(root, 'solar', 'assets', 'live-orbits.js'), 'utf8');
const records = JSON.parse(fs.readFileSync(path.join(root, 'data', 'earth-live.json'), 'utf8'));
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'data', 'earth-live-meta.json'), 'utf8'));
const now = Date.now();
const snapshotEpoch = Date.parse(metadata.fetchedAt);
const sevenDays = 7 * 86400000;
const epochOf = record => Date.parse(record.EPOCH.endsWith('Z') ? record.EPOCH : `${record.EPOCH}Z`);
const countValid = message => message.valid.reduce((sum, value) => sum + value, 0);
const issIndex = records.findIndex(record => Number(record.NORAD_CAT_ID) === 25544);
const staleIndices = records.flatMap((record, index) =>
  Math.abs(snapshotEpoch - epochOf(record)) > sevenDays ? [index] : []);

const report = {
  generated_at_utc: new Date(now).toISOString(),
  script: 'tools/verify-snapshot-worker.cjs',
  worker: 'solar/assets/live-orbits.js',
  method: 'Node vm executes the saved worker against the saved GP records with a controlled wall clock and monotonic session clock.',
  node_version: process.version,
  archive: {
    source: metadata.source,
    fetched_at: metadata.fetchedAt,
    records: records.length,
    outside_seven_day_window_at_snapshot: staleIndices.length,
    stale_norad_ids: staleIndices.map(index => Number(records[index].NORAD_CAT_ID)),
  },
  cases: [],
  checks: [],
  passed: false,
};

function check(name, run) {
  run();
  report.checks.push({check: name, passed: true});
}

function startWorker(wallEpoch, snapshotTime) {
  let elapsed = 0;
  let pending = null;
  let latest = null;
  class ControlledDate extends Date {
    static now() { return wallEpoch + elapsed; }
  }
  const globals = {
    Date: ControlledDate,
    performance: {now: () => elapsed},
    self: {postMessage: message => { latest = message; }},
    setTimeout: callback => { pending = callback; return 1; },
    clearTimeout: () => { pending = null; },
  };
  vm.createContext(globals);
  vm.runInContext(workerCode, globals, {filename: 'live-orbits.js'});
  globals.self.onmessage({data: {
    type: 'init', records, trackIndices: [issIndex],
    ...(snapshotTime === undefined ? {} : {snapshotTime}),
  }});
  assert(latest && latest.type === 'positions', 'worker must return positions after initialization');
  return {
    get: () => latest,
    tick(milliseconds = 2000) {
      assert.equal(typeof pending, 'function', 'worker must schedule another update');
      elapsed += milliseconds;
      const callback = pending;
      pending = null;
      callback();
      return latest;
    },
  };
}

try {
  check('archive metadata and ISS identity are valid', () => {
    assert(Number.isFinite(snapshotEpoch));
    assert.equal(metadata.records, records.length);
    assert(issIndex >= 0);
    assert.equal(staleIndices.length, 34, 'this archived fixture contains 34 stale records');
  });

  for (const [label, wallEpoch] of [['actual_now', now], ['future_2030', Date.parse('2030-01-01T00:00:00Z')]]) {
    const current = startWorker(wallEpoch).get();
    const replay = startWorker(wallEpoch, metadata.fetchedAt);
    const first = replay.get();
    const second = replay.tick();
    const result = {
      case: label,
      wall_time: new Date(wallEpoch).toISOString(),
      current_time_mode_valid_positions: countValid(current),
      snapshot_mode_valid_positions: countValid(first),
      snapshot_time: new Date(first.simulationTime).toISOString(),
      stale_records_hidden: staleIndices.filter(index => first.valid[index] === 0).length,
      tracks: first.tracks.length,
      iss_track_present: first.tracks.some(track => track.index === issIndex),
      elapsed_after_tick_ms: second.simulationTime - first.simulationTime,
      moved_coordinates: Array.from(second.start).filter((value, index) => value !== first.start[index]).length,
    };
    report.cases.push(result);

    check(`${label}: current-UTC mode preserves expiry`, () => {
      assert.equal(current.snapshot, false);
      assert.equal(current.time, wallEpoch);
      assert.equal(current.simulationTime, wallEpoch);
      assert.equal(countValid(current), 0);
    });
    check(`${label}: snapshot mode uses the real archive timestamp`, () => {
      assert.equal(first.snapshot, true);
      assert.equal(first.time, wallEpoch);
      assert.equal(first.simulationTime, snapshotEpoch);
      assert.equal(countValid(first), 16577);
      assert.equal(countValid(first), records.length - staleIndices.length);
    });
    check(`${label}: all 34 expired records remain hidden`, () => {
      for (const index of staleIndices) {
        assert.equal(first.valid[index], 0);
        assert.equal(second.valid[index], 0);
        assert.equal(first.start[index * 3], 0);
        assert.equal(first.start[index * 3 + 1], 0);
        assert.equal(first.start[index * 3 + 2], 0);
        assert(!first.tracks.some(track => track.index === index));
      }
    });
    check(`${label}: positions and ISS orbit geometry are finite`, () => {
      assert(Array.from(first.start).every(Number.isFinite));
      assert(Array.from(first.end).every(Number.isFinite));
      const issTrack = first.tracks.find(track => track.index === issIndex);
      assert(issTrack);
      assert.equal(issTrack.points.length, 97 * 3);
      assert(Array.from(issTrack.points).every(Number.isFinite));
      assert(Array.from(issTrack.points).some(value => value !== 0));
    });
    check(`${label}: replay advances while freshness timestamps stay on the wall clock`, () => {
      assert.equal(second.simulationTime - first.simulationTime, 2000);
      assert.equal(second.time - first.time, 2000);
      assert(result.moved_coordinates > 0);
      assert(Array.from(second.start).every(Number.isFinite));
    });
  }

  check('numeric snapshot timestamp produces the same archive epoch', () => {
    const numeric = startWorker(now, snapshotEpoch).get();
    assert.equal(numeric.snapshot, true);
    assert.equal(numeric.simulationTime, snapshotEpoch);
    assert.equal(countValid(numeric), 16577);
  });
  check('invalid snapshot parameters fall back to current-UTC mode', () => {
    for (const value of ['not-a-date', NaN, Infinity, null]) {
      const invalid = startWorker(now, value).get();
      assert.equal(invalid.snapshot, false);
      assert.equal(invalid.simulationTime, now);
      assert.equal(countValid(invalid), 0);
    }
  });
  report.passed = true;
} catch (error) {
  report.error = {name: error.name, message: error.message, stack: error.stack};
  process.exitCode = 1;
} finally {
  report.passed_checks = report.checks.length;
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({passed: report.passed, checks: report.passed_checks, cases: report.cases, output: outputPath}, null, 2));
}
