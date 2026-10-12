// Lifecycle UI checks use a clearly labelled forecast-module stub, not live API data.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.ATLAS_URL || 'http://127.0.0.1:8766';
const report = {date: new Date().toISOString(), base, forecastData: 'controlled lifecycle stub', checks: [], pageErrors: []};
const stub = `export async function fetchPointForecast(lon,lat,signal,options={}) {
  window.__pointCalls.push({lon,lat,options,time:Date.now()});
  if(window.__pointScenario==='error') throw new Error('Controlled source failure');
  const status=options.offline?'cached':'online';
  const source={status,dataStatus:'available',fetchedAt:new Date().toISOString(),validTime:new Date().toISOString(),intervalSeconds:900,
    ...(options.offline?{cacheReason:'offline'}:{})};
  return {wind:1,direction:90,rain:0,current:.1,currentDirection:180,time:source.validTime,marineTime:source.validTime,rainIntervalSeconds:900,
    sources:{weather:source,marine:{...source}}};
}`;

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem('atlas.weather.online', 'true');
      window.__pointCalls = []; window.__pointScenario = 'online';
      window.__pointOnline = true; window.__pointHidden = false; window.__pointOffset = 0; window.__pointTimers = [];
      const now = Date.now.bind(Date); Date.now = () => now() + window.__pointOffset;
      Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => window.__pointOnline});
      Object.defineProperty(document, 'hidden', {configurable: true, get: () => window.__pointHidden});
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 300000) window.__pointTimers.push(callback);
        return interval(callback, delay, ...args);
      };
    });
    await page.route('**/assets/live-forecast.js', route => route.fulfill({contentType: 'application/javascript', body: stub}));
    const count = () => page.evaluate(() => window.__pointCalls.length);
    const calls = () => page.evaluate(() => window.__pointCalls);
    const settle = () => page.waitForTimeout(650);
    const emit = (events, advance = 11000) => page.evaluate(({events, advance}) => {
      window.__pointOffset += advance;
      for (const name of events) {
        if (name === 'tick') window.__pointTimers.at(-1)?.();
        else (name === 'visibilitychange' ? document : window).dispatchEvent(new Event(name));
      }
    }, {events, advance});
    const check = async (name, fn) => {await fn(); report.checks.push({name, passed: true}); console.log('PASS', name);};
    await page.goto(base + '/?view=globe');
    await page.locator('button').filter({hasText: /^图层/}).click();
    await page.locator('button').filter({hasText: /查询位置气象与海流/}).click();
    await page.locator('.atlas-point-forecast [data-source-status="online"]').first().waitFor();
    await check('Opening the panel automatically requests a point forecast', async () => {
      assert.equal(await count(), 1); assert.equal((await calls())[0].options.offline, false);
    });
    await check('Hidden tab skips interval and focus events', async () => {
      await page.evaluate(() => {window.__pointHidden = true;});
      await emit(['tick', 'focus', 'visibilitychange']); await settle(); assert.equal(await count(), 1);
    });
    await check('Visibility, focus and online burst coalesces into one ordinary update', async () => {
      await page.evaluate(() => {window.__pointHidden = false;});
      await emit(['visibilitychange', 'focus', 'online'], 0); await settle();
      assert.equal(await count(), 2); assert.equal((await calls()).at(-1).options.force, false);
    });
    await check('Repeated focus events are throttled', async () => {
      await emit(['focus', 'focus', 'visibilitychange'], 0); await settle(); assert.equal(await count(), 2);
    });
    await check('Browser offline skips automatic refresh and manual query requests cache only', async () => {
      await page.evaluate(() => {window.__pointOnline = false; window.dispatchEvent(new Event('offline'));});
      await emit(['tick', 'focus']); await settle(); assert.equal(await count(), 2);
      await page.locator('.coordinate-form button').click(); await settle();
      assert.equal(await count(), 3); assert.equal((await calls()).at(-1).options.offline, true);
      assert((await page.locator('.atlas-weather-controls').innerText()).includes('网络已断开'));
    });
    await check('Reconnect automatically refreshes an offline result with one forced request', async () => {
      await page.evaluate(() => {window.__pointOnline = true;});
      await emit(['online', 'focus', 'visibilitychange'], 0); await settle();
      assert.equal(await count(), 4); assert.equal((await calls()).at(-1).options.force, true);
    });
    await check('Explicit offline preference removes automatic event refreshes', async () => {
      await page.getByRole('checkbox',{name:'自动更新数据',exact:true}).uncheck(); await settle();
      const before = await count(); assert.equal((await calls()).at(-1).options.offline, true);
      await emit(['online', 'focus', 'visibilitychange', 'tick']); await settle(); assert.equal(await count(), before);
    });
    await check('Five-minute callback automatically refreshes again after enabling', async () => {
      await page.getByRole('checkbox',{name:'自动更新数据',exact:true}).check(); await settle();
      const before = await count(); await emit(['tick']); await settle();
      assert.equal(await count(), before + 1); assert.equal((await calls()).at(-1).options.force, false);
    });
    await check('Failed source automatically retries when connectivity returns', async () => {
      await page.evaluate(() => {window.__pointScenario = 'error';});
      await page.locator('.coordinate-form button').click(); await settle(); const before = await count();
      await page.evaluate(() => {window.__pointScenario = 'online';});
      await emit(['online'], 0); await settle();
      assert.equal(await count(), before + 1); assert.equal((await calls()).at(-1).options.force, true);
    });
    await check('No browser page exceptions', async () => assert.deepEqual(report.pageErrors, []));
    report.calls = await calls(); report.passed = true;
  } catch (error) {report.passed = false; report.failure = String(error); process.exitCode = 1;}
  finally {
    fs.writeFileSync(path.join(__dirname, '../evidence/point-auto-refresh-validation.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({passed: report.passed, checks: report.checks.length, failure: report.failure}));
    await browser.close();
  }
})();
