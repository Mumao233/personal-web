/* Module behavior tests use labelled fixtures; --live also checks the real APIs in Chrome. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const report = {runAt: new Date().toISOString(), fixtureChecks: [], live: null};
const storage = new Map();
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};

// Fixture schema and sample values are based on the captured Open-Meteo responses.
// These controlled responses exercise failure behavior; they are not live observations.
const fixtureWeather = () => ({latitude: -11.98594, longitude: 65.035904,
  current_units: {time: 'unixtime', interval: 'seconds', wind_speed_10m: 'm/s', wind_direction_10m: '°', precipitation: 'mm'},
  current: {time: 1791783900, interval: 900, wind_speed_10m: 9.27, wind_direction_10m: 132, precipitation: 0}});
const fixtureMarine = () => ({latitude: -11.958336, longitude: 64.95834,
  current_units: {time: 'unixtime', interval: 'seconds', ocean_current_velocity: 'm/s', ocean_current_direction: '°'},
  current: {time: 1791783900, interval: 900, ocean_current_velocity: .16, ocean_current_direction: 252}});
const ok = body => ({ok: true, json: async () => body});
let calls;
function setup(handler) {
  storage.clear(); calls = [];
  global.fetch = async (url, options) => {
    calls.push({url: String(url), options});
    return handler(String(url).includes('marine-api') ? 'marine' : 'weather', options);
  };
}
async function check(name, action) {await action(); report.fixtureChecks.push({name, passed: true});}

(async () => {
  const code = fs.readFileSync(path.join(root, 'assets/live-forecast.js'), 'utf8');
  const {fetchPointForecast} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  await check('weather and marine decode with UTC model time and interval', async () => {
    setup(kind => ok(kind === 'marine' ? fixtureMarine() : fixtureWeather()));
    const value = await fetchPointForecast(65, -12);
    assert.equal(value.wind, 9.27); assert.equal(value.current, .16);
    assert.equal(value.time, '2026-10-12T05:45:00.000Z'); assert.equal(value.rainIntervalSeconds, 900);
    assert.equal(value.sources.weather.status, 'online'); assert.equal(calls.length, 2);
    for (const {url} of calls) assert.equal(new URL(url).searchParams.get('wind_speed_unit'), 'ms');
  });
  await check('recent exact-coordinate cache makes no duplicate network requests', async () => {
    const value = await fetchPointForecast(65, -12);
    assert.equal(calls.length, 2); assert.equal(value.sources.weather.cacheReason, 'recent');
  });
  await check('force refresh performs both API requests', async () => {
    await fetchPointForecast(65, -12, undefined, {force: true}); assert.equal(calls.length, 4);
  });
  await check('explicit offline mode uses cache without requests', async () => {
    const value = await fetchPointForecast(65, -12, undefined, {offline: true, force: true});
    assert.equal(calls.length, 4); assert.equal(value.sources.weather.cacheReason, 'offline');
  });
  await check('uncached offline coordinate rejects without network', async () => {
    await assert.rejects(fetchPointForecast(66, -12, undefined, {offline: true}), {name: 'ForecastUnavailableError'});
    assert.equal(calls.length, 4);
  });
  await check('marine actual km/h response converted to m/s', async () => {
    setup(kind => {const body = kind === 'marine' ? fixtureMarine() : fixtureWeather();
      if (kind === 'marine') {body.current.ocean_current_velocity = 3.6; body.current_units.ocean_current_velocity = 'km/h';}
      return ok(body);
    });
    assert.equal((await fetchPointForecast(65, -12)).current, 1);
  });
  await check('inland null marine values remain missing without hiding weather', async () => {
    setup(kind => {const body = kind === 'marine' ? fixtureMarine() : fixtureWeather();
      if (kind === 'marine') {body.current.ocean_current_velocity = null; body.current.ocean_current_direction = null;}
      return ok(body);
    });
    const value = await fetchPointForecast(116.4, 39.9);
    assert.equal(value.wind, 9.27); assert.equal(value.current, null);
    assert.equal(value.sources.marine.dataStatus, 'no-data');
  });
  await check('weather still succeeds when marine network fails', async () => {
    setup(kind => {if (kind === 'marine') throw new Error('controlled marine failure'); return ok(fixtureWeather());});
    const value = await fetchPointForecast(65, -12);
    assert.equal(value.wind, 9.27); assert.equal(value.current, null);
    assert.equal(value.sources.marine.status, 'unavailable');
  });
  await check('marine still succeeds when weather network fails', async () => {
    setup(kind => {if (kind === 'weather') throw new Error('controlled weather failure'); return ok(fixtureMarine());});
    const value = await fetchPointForecast(65, -12);
    assert.equal(value.wind, null); assert.equal(value.current, .16);
    assert.equal(value.sources.weather.status, 'unavailable');
  });
  await check('failed refresh retains genuine saved values and fetch time', async () => {
    setup(kind => ok(kind === 'marine' ? fixtureMarine() : fixtureWeather()));
    const original = await fetchPointForecast(65, -12);
    global.fetch = async () => {throw new TypeError('controlled offline failure');};
    const value = await fetchPointForecast(65, -12, undefined, {force: true});
    assert.equal(value.wind, original.wind); assert.equal(value.fetchedAt, original.fetchedAt);
    assert.equal(value.sources.weather.cacheReason, 'network-failure');
    assert.match(value.sources.weather.error, /controlled/);
  });
  await check('unknown units invalidate only affected source', async () => {
    setup(kind => {const body = kind === 'marine' ? fixtureMarine() : fixtureWeather();
      if (kind === 'marine') body.current_units.ocean_current_velocity = 'unknown'; return ok(body);});
    const value = await fetchPointForecast(65, -12);
    assert.equal(value.current, null); assert.equal(value.sources.marine.status, 'unavailable');
  });
  await check('missing UTC timestamps are rejected', async () => {
    setup(kind => {const body = kind === 'marine' ? fixtureMarine() : fixtureWeather(); body.current.time = null; return ok(body);});
    await assert.rejects(fetchPointForecast(65, -12), {name: 'ForecastUnavailableError'});
  });
  await check('invalid coordinates reject before requests', async () => {
    setup(() => {throw new Error('must not request');});
    await assert.rejects(fetchPointForecast(181, -12), RangeError);
    await assert.rejects(fetchPointForecast(65, NaN), RangeError); assert.equal(calls.length, 0);
  });
  await check('caller cancellation never returns fallback', async () => {
    setup((kind, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
    }));
    const controller = new AbortController();
    const promise = fetchPointForecast(65, -12, controller.signal);
    controller.abort(); await assert.rejects(promise, {name: 'AbortError'});
  });
  await check('cache remains bounded to 24 coordinates', async () => {
    setup(kind => ok(kind === 'marine' ? fixtureMarine() : fixtureWeather()));
    for (let lon = 0; lon < 30; lon++) await fetchPointForecast(lon, -12);
    const saved = JSON.parse(storage.get('atlas-point-forecast-v1'));
    assert.equal(Object.keys(saved.entries).length, 24);
  });
  await check('disabled browser storage does not prevent online queries', async () => {
    global.localStorage = {getItem() {throw new Error('disabled');}, setItem() {throw new Error('disabled');}};
    assert.equal((await fetchPointForecast(65, -12)).wind, 9.27);
  });

  if (process.argv.includes('--live')) {
    const {chromium} = require('playwright');
    const browser = await chromium.launch({channel: 'chrome', headless: true});
    try {
      const page = await browser.newPage();
      const network = [];
      page.on('response', response => {if (/open-meteo\.com/.test(response.url())) network.push({url: response.url(), status: response.status()});});
      await page.goto((process.env.ATLAS_URL || 'http://127.0.0.1:8766') + '/assets/live-forecast.js');
      report.live = await page.evaluate(async () => {
        const {fetchPointForecast} = await import('/assets/live-forecast.js');
        localStorage.removeItem('atlas-point-forecast-v1');
        const sea = await fetchPointForecast(65, -12, undefined, {force: true});
        const land = await fetchPointForecast(116.4, 39.9, undefined, {force: true});
        const offline = await fetchPointForecast(65, -12, undefined, {offline: true});
        return {sea, land, offline};
      });
      report.live.network = network;
      assert.equal(report.live.sea.sources.weather.status, 'online');
      assert.equal(report.live.sea.sources.marine.status, 'online');
      assert(Number.isFinite(report.live.sea.wind)); assert(Number.isFinite(report.live.sea.current));
      assert.equal(report.live.land.current, null); assert.equal(report.live.land.sources.marine.dataStatus, 'no-data');
      assert.equal(report.live.offline.sources.weather.cacheReason, 'offline');
      assert.equal(network.length, 4); assert(network.every(item => item.status === 200));
    } finally {await browser.close();}
  }
  const output = path.join(root, 'evidence/point-forecast-module.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({fixtureChecks: report.fixtureChecks.length, live: !!report.live, output}));
})().catch(error => {console.error(error); process.exitCode = 1;});
