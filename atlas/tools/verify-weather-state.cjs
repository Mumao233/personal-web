/* Deterministic store tests with labelled synthetic transport/grid fixtures.
 * No browser, remote requests, server, production edits, or wall-clock sleeps.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/weather-state.js'), 'utf8')
  .replace('export function createWeatherState', 'function createWeatherState');
const report = {
  runAt: new Date().toISOString(),
  method: 'Node VM with isolated mock fetch, controlled clock/timers, and synthetic 2x2 grid fixtures; not a live-data test',
  checks: [],
};
const start = Date.parse('2026-10-12T06:00:00Z');
const archive = {
  width: 2, height: 2, binary: '/weather/surface.bin', cloudBinary: '/weather/clouds.bin',
  downloadedAt: '2026-10-03T09:32:31Z', validTime: '2026-10-03T09:00:00Z',
};
function live(generation = 1, refreshing = false) {
  return {...archive, binary: '/__local/weather/gfs-surface.bin', cloudBinary: '/__local/weather/gfs-clouds.bin',
    downloadedAt: new Date(start + generation * 1000).toISOString(),
    validTime: new Date(start).toISOString(), online: true,
    weatherStatus: {refreshing, mode: 'live', error: null}};
}
const response = (body, {backend = true, ok = true} = {}) => ({
  ok, headers: {get(name) {
    return name.toLowerCase() === 'content-type' ? 'application/json' :
      name.toLowerCase() === 'x-atlas-live-weather' && backend ? '1' : null;
  }},
  json: async () => structuredClone(body), text: async () => '<!doctype html><title>fixture</title>',
});
function harness({search = '', stored = null, handler, binaryHandler, connected = true, hidden = false} = {}) {
  let now = start, timerId = 0, state;
  const timers = new Map(), requests = [], binaries = [], changes = [], storage = new Map();
  const events = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) {listeners.get(type)?.delete(listener);},
      dispatchEvent(event) {for (const listener of [...listeners.get(event.type) || []]) listener(event);},
    };
  };
  const windowEvents = events(), document = {...events(), hidden}, navigator = {onLine: connected};
  if (stored !== null) storage.set('atlas.weather.online', stored);
  const sandbox = {
    URLSearchParams, Float32Array, Number, Date: class extends Date {static now() {return now;}},
    location: {search}, document, navigator,
    addEventListener: windowEvents.addEventListener, removeEventListener: windowEvents.removeEventListener,
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    AbortSignal: {timeout: () => new AbortController().signal},
    setTimeout: (callback, delay) => {const id = ++timerId; timers.set(id, {callback, due: now + delay, delay}); return id;},
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => {const id = ++timerId; timers.set(id, {callback, due: now + delay, delay, interval: true}); return id;},
    clearInterval: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const call = {url, method: options.method || 'GET'}; requests.push(call);
      const custom = handler && await handler(call, requests);
      if (custom !== undefined) return custom;
      if (url === '/') return response(null);
      if (url === '/weather/gfs-surface.json') return response(archive);
      if (url === '/__local/weather/refresh') return response({refreshing: true});
      if (url.startsWith('/__local/weather/gfs-surface.json')) return response(live());
      throw Error('Unexpected mock request: ' + url);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.factory = createWeatherState;', sandbox);
  const set = patch => {state = {...state, ...patch}; changes.push(patch);};
  state = sandbox.factory(set, () => state, {
    decodeGrid: (meta, buffer) => {
      assert.equal(buffer.byteLength, meta.width * meta.height * 12);
      return {...meta, values: new Float32Array(buffer)};
    },
    loadBinary: async (url, parts) => {
      binaries.push(url);
      const custom = binaryHandler && await binaryHandler(url, parts);
      if (custom !== undefined) return custom;
      return url.includes('cloud') ? new Float32Array([0, .25, .5, 1]).buffer : new Float32Array(12).buffer;
    },
  });
  return {
    get state() {return state;}, set, requests, binaries, timers, changes, storage, document, navigator,
    dispatchWindow(type) {windowEvents.dispatchEvent({type});},
    dispatchDocument(type) {document.dispatchEvent({type});},
    listenerCount() {
      return [...windowEvents.listeners.values(), ...document.listeners.values()].reduce((count, list) => count + list.size, 0);
    },
    advanceClock(ms) {now += ms;},
    async tick() {
      assert(timers.size, 'Expected a store-owned poll timer');
      const [id, item] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      timers.delete(id); now = Math.max(now, item.due);
      if (item.interval) timers.set(id, {...item, due: now + item.delay});
      await item.callback();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
    async settle() {for (let i = 0; i < 50; i++) await Promise.resolve();},
  };
}
async function check(name, action) {
  try {const details = await action(); report.checks.push({name, passed: true, ...(details ? {details} : {})});}
  catch (error) {report.checks.push({name, passed: false, error: error.stack}); console.error(name + ': ' + error.message);}
}

(async () => {
  await check('manual refresh completes through store poll with no globe/layer lifecycle', async () => {
    let reads = 0;
    const h = harness({handler: ({url}) => {
      if (url === '/__local/weather/gfs-surface.json') return response(++reads === 1
        ? {...archive, online: false, weatherStatus: {refreshing: true, mode: 'archive'}} : live());
    }});
    await h.state.load({force: true});
    assert.equal(h.state.grid.binary, archive.binary);
    assert.equal(h.state.weatherStatus.refreshing, true);
    assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 2000);
    await h.tick();
    assert.equal(h.state.grid.binary, live().binary); assert.equal(h.state.online, true);
    assert.equal(h.state.weatherStatus.refreshing, false); assert.equal(h.timers.size, 0);
    assert.equal(h.requests.filter(x => x.method === 'POST').length, 1);
    return {backendManifestReads: reads, finalMode: h.state.weatherStatus.mode, remainingTimers: h.timers.size};
  });
  await check('unfinished job rearms exactly one poll and stops when complete', async () => {
    let reads = 0;
    const h = harness({handler: ({url}) => url === '/__local/weather/gfs-surface.json'
      ? response(live(1, ++reads < 3)) : undefined});
    await h.state.load({force: true});
    assert.equal(h.timers.size, 1); await h.tick(); assert.equal(h.timers.size, 1);
    await h.tick(); assert.equal(h.timers.size, 0); assert.equal(reads, 3);
    assert.equal(h.requests.filter(x => x.method === 'POST').length, 1);
  });
  await check('concurrent loads share one pending request', async () => {
    let release;
    const held = new Promise(resolve => {release = resolve;});
    const h = harness({handler: ({url}) => url === '/weather/gfs-surface.json' ? held : undefined});
    const first = h.state.load(), second = h.state.load();
    assert.equal(first, second); assert.equal(h.requests.length, 1);
    release(response(archive)); await first;
    assert.equal(h.requests.filter(x => x.url === '/__local/weather/gfs-surface.json').length, 1);
  });
  await check('URL offline preference overrides saved online preference and never calls online refresh', async () => {
    const h = harness({search: '?weather=offline', stored: 'true', handler: ({url}) =>
      url.endsWith('?offline=1') ? response(live(1, true)) : undefined});
    assert.equal(h.state.liveEnabled, false);
    await h.state.load({force: true});
    assert.equal(h.state.online, false); assert.equal(h.timers.size, 0);
    assert(h.requests.some(x => x.url.endsWith('?offline=1')));
    assert(!h.requests.some(x => x.url === '/__local/weather/gfs-surface.json' || x.method === 'POST'));
  });
  await check('persisted offline preference is honored', async () => {
    const h = harness({stored: 'false'});
    assert.equal(h.state.liveEnabled, false); await h.state.load();
    assert(!h.requests.some(x => x.method === 'POST' || x.url === '/__local/weather/gfs-surface.json'));
  });
  await check('force refresh reprobes a previously failed backend capability check', async () => {
    let available = false;
    const h = harness({handler: ({url}) => url === '/' ? response(null, {backend: available}) : undefined});
    await h.state.load(); assert.equal(h.state.backendAvailable, false);
    available = true;
    await h.state.load(); assert.equal(h.requests.filter(x => x.url === '/').length, 1);
    await h.state.load({force: true});
    assert.equal(h.requests.filter(x => x.url === '/').length, 2);
    assert.equal(h.requests.filter(x => x.method === 'POST').length, 1);
    assert.equal(h.state.backendAvailable, true); assert.equal(h.state.online, true);
  });
  await check('failed backend discovery expires after one minute without force', async () => {
    let available = false;
    const h = harness({handler: ({url}) => url === '/' ? response(null, {backend: available}) : undefined});
    await h.state.load(); available = true; h.advanceClock(60001); await h.state.load();
    assert.equal(h.requests.filter(x => x.url === '/').length, 2);
    assert.equal(h.state.backendAvailable, true);
  });
  await check('failed cloud fetch preserves previous complete grid and allows retry', async () => {
    let generation = 1, failCloud = false;
    const h = harness({handler: ({url}) => url === '/__local/weather/gfs-surface.json' ? response(live(generation)) : undefined,
      binaryHandler: url => {if (failCloud && url.includes('/__local/') && url.includes('cloud')) throw Error('controlled cloud download failure');}});
    await h.state.load(); const previous = h.state.grid;
    generation = 2; failCloud = true; await h.state.load({force: true});
    assert.equal(h.state.grid, previous); assert.equal(h.state.state, 'ready');
    assert.equal(h.state.online, false); assert.match(h.state.updateError, /controlled cloud/);
    assert.equal(h.state.weatherStatus.refreshing, false); assert.equal(h.timers.size, 0);
    failCloud = false; await h.state.load({force: true});
    assert.equal(h.state.grid.downloadedAt, live(2).downloadedAt); assert.equal(h.state.updateError, null);
  });
  await check('invalid cloud length and non-finite fractions cannot replace valid snapshot', async () => {
    for (const buffer of [new Float32Array(3).buffer, new Float32Array([0, NaN, 0, 1]).buffer,
      new Float32Array([0, 1.1, 0, 1]).buffer]) {
      const h = harness({binaryHandler: url => url.includes('/__local/') && url.includes('cloud') ? buffer : undefined});
      await h.state.load();
      assert.equal(h.state.grid.binary, archive.binary); assert.equal(h.state.online, false);
      assert.match(h.state.updateError, /Invalid cloud/); assert.equal(h.timers.size, 0);
    }
  });
  await check('switching offline cancels a scheduled poll and persists preference', async () => {
    const h = harness({handler: ({url}) => url.startsWith('/__local/weather/gfs-surface.json') ? response(live(1, true)) : undefined});
    await h.state.load({force: true}); assert.equal(h.timers.size, 1);
    const before = h.requests.length; h.state.setLiveEnabled(false); await h.settle();
    assert.equal(h.storage.get('atlas.weather.online'), 'false'); assert.equal(h.state.liveEnabled, false);
    assert.equal(h.state.online, false); assert.equal(h.timers.size, 0);
    assert(h.requests.slice(before).every(x => x.url.endsWith('?offline=1')));
  });
  await check('preference change during in-flight metadata suppresses stale online publication', async () => {
    let release, started;
    const entered = new Promise(resolve => {started = resolve;});
    const held = new Promise(resolve => {release = resolve;});
    const h = harness({handler: ({url}) => {if (url === '/__local/weather/gfs-surface.json') {started(); return held;}}});
    const promise = h.state.load(); await entered;
    h.state.setLiveEnabled(false); release(response(live(2, true))); await promise; await h.settle();
    assert(!h.changes.some(patch => patch.online === true));
    assert.equal(h.state.liveEnabled, false); assert.equal(h.state.online, false); assert.equal(h.timers.size, 0);
    assert(h.requests.some(x => x.url.endsWith('?offline=1')));
  });
  await check('poll fetch error retains grid and stops automatic polling loop', async () => {
    let reads = 0;
    const h = harness({handler: ({url}) => {
      if (url === '/__local/weather/gfs-surface.json') {
        if (++reads > 1) throw Error('controlled poll transport failure');
        return response(live(1, true));
      }
    }});
    await h.state.load({force: true}); const previous = h.state.grid; await h.tick();
    assert.equal(h.state.grid, previous); assert.equal(h.timers.size, 0);
    assert.equal(h.state.weatherStatus.refreshing, false); assert.match(h.state.updateError, /controlled poll/);
  });
  await check('automatic lifecycle loads current grid at startup without manual action', async () => {
    const h = harness();
    const stop = h.state.startAutoUpdate(); await h.settle();
    assert.equal(typeof stop, 'function'); assert.equal(h.state.liveEnabled, true);
    assert.equal(h.state.online, true);
    assert.equal(h.requests.filter(x => x.url === '/__local/weather/gfs-surface.json').length, 1);
    assert(!h.requests.some(x => x.method === 'POST'));
    assert.equal([...h.timers.values()].filter(x => x.interval && x.delay === 60000).length, 1);
    assert(h.listenerCount() >= 4);
    stop(); assert.equal(h.timers.size, 0); assert.equal(h.listenerCount(), 0);
  });
  await check('minute checks fetch local metadata without forcing upstream downloads', async () => {
    const h = harness(); const stop = h.state.startAutoUpdate(); await h.settle();
    await h.tick(); await h.tick();
    assert.equal(h.requests.filter(x => x.url === '/__local/weather/gfs-surface.json').length, 3);
    assert(!h.requests.some(x => x.method === 'POST'));
    stop();
  });
  await check('background pages skip minute updates and resume when visible', async () => {
    const h = harness(); const stop = h.state.startAutoUpdate(); await h.settle();
    const before = h.requests.length; h.document.hidden = true; await h.tick();
    assert.equal(h.requests.length, before);
    h.document.hidden = false; h.dispatchDocument('visibilitychange'); await h.tick();
    assert.equal(h.requests.filter(x => x.url === '/__local/weather/gfs-surface.json').length, 2);
    stop();
  });
  await check('focus online and visibility bursts coalesce and respect the ten-second throttle', async () => {
    const h = harness(); const stop = h.state.startAutoUpdate(); await h.settle();
    h.advanceClock(11000);
    h.dispatchWindow('focus'); h.dispatchWindow('online'); h.dispatchDocument('visibilitychange');
    assert.equal([...h.timers.values()].filter(x => !x.interval).length, 1);
    await h.tick();
    const after = h.requests.filter(x => x.url === '/__local/weather/gfs-surface.json').length;
    assert.equal(after, 2);
    h.dispatchWindow('focus'); h.dispatchDocument('visibilitychange'); await h.settle();
    if ([...h.timers.values()].some(x => !x.interval)) await h.tick();
    assert.equal(h.requests.filter(x => x.url === '/__local/weather/gfs-surface.json').length, after);
    stop();
  });
  await check('automatic startup honors explicit offline preference', async () => {
    const h = harness({stored: 'false'}); const stop = h.state.startAutoUpdate(); await h.settle();
    assert.equal(h.state.liveEnabled, false); assert.equal(h.state.online, false);
    await h.tick();
    assert(!h.requests.some(x => x.method === 'POST' || x.url === '/__local/weather/gfs-surface.json'));
    assert(h.requests.some(x => x.url.endsWith('?offline=1'))); stop();
  });
  await check('browser disconnected startup requests only saved local metadata', async () => {
    const h = harness({connected: false}); const stop = h.state.startAutoUpdate(); await h.settle();
    assert.equal(h.state.liveEnabled, true); assert.equal(h.state.networkAvailable, false);
    assert.equal(h.state.online, false);
    assert(!h.requests.some(x => x.method === 'POST' || x.url === '/__local/weather/gfs-surface.json'));
    assert(h.requests.some(x => x.url.endsWith('?offline=1'))); stop();
  });
  await check('offline then online browser events update availability and resume fetching', async () => {
    const h = harness(); const stop = h.state.startAutoUpdate(); await h.settle();
    h.navigator.onLine = false; const before = h.requests.length;
    h.dispatchWindow('offline'); await h.settle();
    assert.equal(h.state.networkAvailable, false); assert.equal(h.state.online, false);
    if ([...h.timers.values()].some(x => !x.interval)) await h.tick();
    assert(!h.requests.slice(before).some(x => x.method === 'POST' || x.url === '/__local/weather/gfs-surface.json'));
    h.advanceClock(11000); h.navigator.onLine = true; h.dispatchWindow('online');
    await h.tick(); assert.equal(h.state.networkAvailable, true); assert.equal(h.state.online, true);
    stop();
  });
  await check('lifecycle cleanup removes timers and listeners and ignores later events', async () => {
    const h = harness(); const stop = h.state.startAutoUpdate(); await h.settle();
    h.advanceClock(11000); h.dispatchWindow('focus');
    assert(h.timers.size > 1); stop(); stop();
    assert.equal(h.listenerCount(), 0); assert.equal(h.timers.size, 0);
    const before = h.requests.length;
    h.dispatchWindow('online'); h.dispatchWindow('focus'); h.dispatchDocument('visibilitychange');
    await h.settle(); assert.equal(h.requests.length, before);
  });
  await check('lifecycle ownership is reference-counted and a clean restart works', async () => {
    const h = harness(); const stopFirst = h.state.startAutoUpdate(), stopSecond = h.state.startAutoUpdate();
    await h.settle();
    assert.equal(h.listenerCount(), 4); assert.equal(h.timers.size, 1);
    assert.equal(h.requests.filter(x => x.url === '/__local/weather/gfs-surface.json').length, 1);
    stopFirst(); stopFirst(); assert.equal(h.listenerCount(), 4); await h.tick();
    stopSecond(); assert.equal(h.listenerCount(), 0); assert.equal(h.timers.size, 0);
    const stopThird = h.state.startAutoUpdate(); await h.settle();
    assert.equal(h.listenerCount(), 4); assert.equal(h.timers.size, 1); stopThird();
  });
  await check('hidden initial page delays automatic fetching until visible', async () => {
    const h = harness({hidden: true}); const stop = h.state.startAutoUpdate(); await h.settle();
    assert.equal(h.requests.length, 0); await h.tick(); assert.equal(h.requests.length, 0);
    h.document.hidden = false; h.dispatchDocument('visibilitychange'); await h.tick();
    assert.equal(h.state.online, true); stop();
  });
  await check('disconnect during in-flight metadata cannot republish an online status', async () => {
    let release, entered;
    const started = new Promise(resolve => {entered = resolve;});
    const held = new Promise(resolve => {release = resolve;});
    const h = harness({handler: ({url}) => {if (url === '/__local/weather/gfs-surface.json') {entered(); return held;}}});
    const stop = h.state.startAutoUpdate(); await started;
    h.navigator.onLine = false; h.dispatchWindow('offline'); release(response(live())); await h.settle();
    assert.equal(h.state.networkAvailable, false); assert.equal(h.state.online, false); stop();
  });
  await check('cleanup during in-flight update cannot rearm a backend poll afterwards', async () => {
    let release, entered;
    const started = new Promise(resolve => {entered = resolve;});
    const held = new Promise(resolve => {release = resolve;});
    const h = harness({handler: ({url}) => {if (url === '/__local/weather/gfs-surface.json') {entered(); return held;}}});
    const stop = h.state.startAutoUpdate(); await started; stop();
    release(response(live(1, true))); await h.settle();
    assert.equal(h.listenerCount(), 0); assert.equal(h.timers.size, 0);
  });
  await check('disconnect during initial snapshot prevents subsequent upstream-enabled requests', async () => {
    let release, entered;
    const started = new Promise(resolve => {entered = resolve;});
    const held = new Promise(resolve => {release = resolve;});
    const h = harness({handler: ({url}) => {if (url === '/weather/gfs-surface.json') {entered(); return held;}}});
    const stop = h.state.startAutoUpdate(); await started;
    h.navigator.onLine = false; h.dispatchWindow('offline');
    release(response(archive)); await h.settle();
    assert.equal(h.state.online, false); assert.equal(h.state.networkAvailable, false);
    assert(!h.requests.some(x => x.method === 'POST' || x.url === '/__local/weather/gfs-surface.json'));
    assert(h.requests.some(x => x.url.endsWith('?offline=1'))); stop();
  });
  report.passed = report.checks.every(item => item.passed);
  if (!report.passed) process.exitCode = 1;
})().catch(error => {report.passed = false; console.error(error); process.exitCode = 1;}).finally(() => {
  const output = path.join(root, 'evidence/weather-state-validation.json');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({passed: report.passed, checks: report.checks.length, output}));
});
