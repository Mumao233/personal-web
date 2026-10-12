// Browser lifecycle check: real local GFS responses; clock acceleration only.
const {chromium} = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const base = process.env.ATLAS_URL || 'http://127.0.0.1:8766';
(async () => {
  const result = {date:new Date().toISOString(), checks:[], errors:[], failedRequests:[], metadataResponses:[]};
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => result.errors.push(String(e)));
  page.on('requestfailed', r => result.failedRequests.push({url:r.url(),method:r.method(),error:r.failure()}));
  page.on('console', m => {if(m.type()==='error')result.errors.push(m.text());});
  page.on('response', r => {
    if(r.url().includes('/__local/weather/gfs-surface.json'))result.metadataResponses.push({url:r.url(),status:r.status()});
    if(r.status()>=400)result.errors.push(r.status()+' '+r.url());
  });
  const waitForMeta = () => page.waitForResponse(r=>r.url().includes('/__local/weather/gfs-surface.json') && r.status()===200);
  try {
    await page.clock.install();
    const initial = waitForMeta();
    await page.goto(base+'/?view=globe&from=solar');
    const meta = await (await initial).json();
    await page.locator('.cesium-widget canvas').waitFor();
    assert(meta.validTime && meta.source.includes('GFS'));
    assert(await page.locator('.workspace-panel').count()===0);
    result.checks.push({name:'Earth opening automatically loads GFS with no menu/layer/forecast-panel click',passed:true,validTime:meta.validTime});
    // Finish the initial tile/audio/chunk burst before jumping the animation clock.
    await page.waitForLoadState('networkidle');
    const next = waitForMeta();
    await page.clock.fastForward(61000);
    await next;
    result.checks.push({name:'The one-minute foreground scheduler checks the real local backend automatically',passed:true});
    const count=result.metadataResponses.length;
    await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
    await page.clock.fastForward(61000);
    await page.waitForTimeout(500);
    assert.equal(result.metadataResponses.length,count);
    result.checks.push({name:'Background document stops periodic automatic checks',passed:true});
    const visible = waitForMeta();
    await page.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:false});
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.clock.fastForward(300);
    await visible;
    await page.waitForTimeout(500);
    assert.equal(result.metadataResponses.length,count+1);
    result.checks.push({name:'Returning to the document coalesces focus and visibility into one automatic check',passed:true});
    assert(!result.errors.length,JSON.stringify(result.errors));
    result.passed=true;
  } catch(error) {result.passed=false;result.failure=error.stack;}
  finally {
    fs.writeFileSync(path.join(__dirname,'../evidence/auto-weather-browser.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    await browser.close();
    if(!result.passed)process.exitCode=1;
  }
})();
