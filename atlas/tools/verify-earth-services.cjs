/** Actual UI + Chromium rendering checks for the six newly connected Earth services. */
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const fs = require('fs'), path = require('path'), assert = require('assert');
const base = process.env.ATLAS_URL || 'http://127.0.0.1:8766';
const output = path.join(__dirname, '../evidence');
const ids = ['sst','salinity','chlorophyll','plates','trenches','eez'];
const report = {date:new Date().toISOString(),base,modes:[],passed:false};

function changedPixels(a,b) {
  const left=PNG.sync.read(a),right=PNG.sync.read(b);assert.equal(left.width,right.width);assert.equal(left.height,right.height);
  let changed=0,total=left.width*left.height;
  for(let k=0;k<left.data.length;k+=4) if(Math.max(...[0,1,2].map(i=>Math.abs(left.data[k+i]-right.data[k+i])))>24) changed++;
  return {changed,total,fraction:changed/total};
}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const mode of ['online','offline']) {
      const result={mode,checks:[],responses:[],externalRequests:[],httpErrors:[],consoleErrors:[],pageErrors:[],requestFailures:[]};
      report.modes.push(result);
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      await context.addInitScript(mode=>{
        localStorage.setItem('atlas.weather.online',mode==='online'?'true':'false');
        window.__referenceEvents=[];
        window.addEventListener('atlas-reference-status',event=>window.__referenceEvents.push(event.detail));
      },mode);
      if(mode==='offline') await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(!['127.0.0.1','localhost'].includes(url.hostname)) {result.externalRequests.push(url.href);return route.abort('internetdisconnected');}
        return route.continue();
      });
      const page=await context.newPage();page.setDefaultTimeout(30000);
      const activeRequests=new Map();
      page.on('request',r=>activeRequests.set(r,{url:r.url(),type:r.resourceType(),started:Date.now()}));
      page.on('requestfinished',r=>activeRequests.delete(r));
      page.on('requestfailed',r=>activeRequests.delete(r));
      page.on('pageerror',e=>result.pageErrors.push(String(e)));
      page.on('console',msg=>{if(msg.type()==='error')result.consoleErrors.push(msg.text());});
      page.on('requestfailed',r=>result.requestFailures.push({time:new Date().toISOString(),url:r.url(),error:r.failure()}));
      page.on('response',r=>{result.responses.push({time:new Date().toISOString(),url:r.url(),status:r.status()});if(r.status()>=400)result.httpErrors.push({url:r.url(),status:r.status()});});
      try {
        await page.goto(base+'/?view=globe&from=solar');
        await page.locator('.cesium-widget canvas').waitFor();
        // A playing MP3 can keep Chromium's global networkidle pending forever.
        // Wait for textures/scripts/data to settle while retaining ALL failures below.
        let quietSince=Date.now();
        const initialDeadline=Date.now()+45000;
        while(Date.now()-quietSince<2000&&Date.now()<initialDeadline){
          const active=[...activeRequests.values()].filter(r=>r.type!=='media');
          if(active.length)quietSince=Date.now();
          await page.waitForTimeout(100);
        }
        result.initialPendingRequests=[...activeRequests.values()];
        assert(Date.now()-quietSince>=2000,'Initial non-media resources did not settle: '+JSON.stringify(result.initialPendingRequests));
        await page.locator('button').filter({hasText:/^图层/}).click();
        await page.locator('button').filter({hasText:/全部图层与来源/}).click();
        await page.locator('[data-service="sst"]').waitFor();
        assert.equal(await page.getByRole('checkbox',{name:'自动更新数据',exact:true}).isChecked(),mode==='online');
        await page.waitForTimeout(1800);
        for(const id of ids) {
          const detail=page.locator(`[data-service="${id}"]`);
          await detail.waitFor();
          const row=detail.locator('..'),toggle=row.getByRole('switch');
          await row.scrollIntoViewIfNeeded();
          assert.equal(await toggle.getAttribute('aria-checked'),'false',id+' should initially be disabled');
          const before=await page.screenshot({clip:{x:430,y:250,width:420,height:500}});
          await toggle.click();
          await page.waitForFunction(id=>document.querySelector(`[data-service="${id}"]`)?.dataset.renderStatus==='ready',id);
          await page.waitForTimeout(2000);
          assert.equal(await toggle.getAttribute('aria-checked'),'true');
          const text=await detail.innerText();
          if(['sst','salinity','chlorophyll'].includes(id)) {
            assert(/20\d{2}-\d{2}-\d{2}/.test(text),'Missing real product date for '+id);
            if(id==='sst')assert(/分析|analysis/.test(text));
            if(id==='salinity')assert(/8 日|8-day/.test(text));
            if(id==='chlorophyll')assert(/卫星日影像|satellite/.test(text));
            assert(await detail.locator('img').evaluateAll(es=>es.length>0&&es.every(e=>e.complete&&e.naturalWidth>0)),'Missing official legend for '+id);
          }else if(id==='eez') {
            assert(text.includes('v12')&&text.includes('2023')&&text.includes('非法律'));
            assert(await detail.locator('img').evaluateAll(es=>es.length===1&&es[0].complete&&es[0].naturalWidth>0));
          }else assert(text.includes('PB2002'));
          let after=await page.screenshot({clip:{x:430,y:250,width:420,height:500}});
          let pixels=changedPixels(before,after);
          // Ground polylines finish worker geometry after the data-source Promise resolves.
          // Wait for pixels, rather than equating a successful download with rendered geometry.
          const renderDeadline=Date.now()+15000;
          while(pixels.changed<=150&&Date.now()<renderDeadline){
            await page.waitForTimeout(1000);
            after=await page.screenshot({clip:{x:430,y:250,width:420,height:500}});
            pixels=changedPixels(before,after);
          }
          assert(pixels.changed>150,`${id}: no meaningful visual change (${pixels.changed} pixels)`);
          await page.screenshot({path:path.join(output,`services-${mode}-${id}.png`)});
          await toggle.click();await page.waitForTimeout(600);
          assert.equal(await toggle.getAttribute('aria-checked'),'false');
          assert.equal(await detail.locator('img').count(),0,'Legend should hide when layer is disabled');
          await toggle.click();await page.waitForTimeout(350);
          assert.equal(await toggle.getAttribute('aria-checked'),'true');
          await toggle.click();await page.waitForTimeout(300);
          result.checks.push({id,passed:true,text,pixels,reenablePassed:true});
        }
        result.referenceEvents=await page.evaluate(()=>window.__referenceEvents);
        for(const [id,count] of [['plates',241],['trenches',662]])assert(result.referenceEvents.some(e=>e.id===id&&e.status==='ready'&&e.features===count));
        const metadata=result.responses.filter(r=>r.url.includes('/__local/ocean/')&&r.url.includes('/metadata'));
        assert(metadata.length>=3,'Ocean service metadata was never requested');
        if(mode==='offline') {
          assert(metadata.every(r=>new URL(r.url).searchParams.get('offline')==='1'));
          assert.equal(result.externalRequests.length,0,JSON.stringify(result.externalRequests));
        }
        for(const name of ['httpErrors','consoleErrors','pageErrors','requestFailures'])assert.equal(result[name].length,0,JSON.stringify(result[name]));
        result.passed=true;
      }catch(error){result.passed=false;result.failure=String(error);result.stack=error.stack;await page.screenshot({path:path.join(output,`services-${mode}-failure.png`)}).catch(()=>{});}
      finally{await context.close();fs.writeFileSync(path.join(output,'earth-services-validation.json'),JSON.stringify(report,null,2));}
    }
    report.passed=report.modes.every(m=>m.passed);
  }finally{await browser.close();fs.writeFileSync(path.join(output,'earth-services-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;}
})();
