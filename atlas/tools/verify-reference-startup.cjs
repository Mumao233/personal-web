/** Cold-start reference rendering regression, without moving the globe to force a frame. */
const {chromium}=require('playwright');
const {PNG}=require('pngjs');
const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const base=process.env.ATLAS_URL||'http://127.0.0.1:8766';
const output=path.join(__dirname,'../evidence');
const report={date:new Date().toISOString(),base,bundleSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../assets/earth-entry-S7CI26MD.js'))).digest('hex'),runs:[],passed:false};
function changedPixels(a,b){
  const x=PNG.sync.read(a),y=PNG.sync.read(b);let n=0;
  for(let i=0;i<x.data.length;i+=4)if(Math.max(...[0,1,2].map(k=>Math.abs(x.data[i+k]-y.data[i+k])))>24)n++;
  return n;
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,args:process.env.ATLAS_NETLOG?[`--log-net-log=${process.env.ATLAS_NETLOG}`]:[]});
  try{
    for(let run=0;run<Number(process.env.ATLAS_STARTUP_RUNS||6);run++){
      const id=run%2?'trenches':'plates',mode=run<3?'online':'offline';
      const r={run:run+1,id,mode,passed:false,failures:[],cdpFailures:[],httpErrors:[],consoleErrors:[],pageErrors:[],cloudResponses:[],externalRequests:[]};report.runs.push(r);
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      await context.addInitScript(mode=>localStorage.setItem('atlas.weather.online',String(mode==='online')),mode);
      if(mode==='offline')await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(!['127.0.0.1','localhost'].includes(url.hostname)){r.externalRequests.push(url.href);return route.abort('internetdisconnected');}
        return route.continue();
      });
      const page=await context.newPage(),active=new Map();page.setDefaultTimeout(30000);
      const cdp=await context.newCDPSession(page),cdpRequests=new Map();
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent',e=>cdpRequests.set(e.requestId,{url:e.request.url,wallTime:e.wallTime,timestamp:e.timestamp,type:e.type,initiator:e.initiator}));
      cdp.on('Network.loadingFailed',e=>r.cdpFailures.push({...e,request:cdpRequests.get(e.requestId)}));
      page.on('request',q=>active.set(q,{url:q.url(),type:q.resourceType()}));
      page.on('requestfinished',q=>active.delete(q));
      page.on('requestfailed',q=>{active.delete(q);r.failures.push({time:new Date().toISOString(),url:q.url(),type:q.resourceType(),timing:q.timing(),failure:q.failure()});});
      page.on('console',m=>{if(m.type()==='error')r.consoleErrors.push(m.text());});
      page.on('pageerror',e=>r.pageErrors.push(String(e)));
      page.on('response',q=>{if(q.status()>=400)r.httpErrors.push({url:q.url(),status:q.status()});if(q.url().includes('/cloud-tiles/'))r.cloudResponses.push({url:q.url(),status:q.status()});});
      try{
        await page.goto(base+'/?view=globe&from=solar');await page.locator('.cesium-widget canvas').waitFor();
        let quietSince=Date.now();const deadline=Date.now()+45000;
        while(Date.now()-quietSince<2000&&Date.now()<deadline){if([...active.values()].some(q=>q.type!=='media'))quietSince=Date.now();await page.waitForTimeout(100);}
        r.pending=[...active.values()];assert(Date.now()-quietSince>=2000,'Initial non-media resources did not settle');
        await page.locator('button').filter({hasText:/^图层/}).click();
        await page.locator('button').filter({hasText:/全部图层与来源/}).click();
        const detail=page.locator(`[data-service="${id}"]`),row=detail.locator('..'),toggle=row.getByRole('switch');
        await row.scrollIntoViewIfNeeded();
        const clip={x:430,y:250,width:420,height:500};
        const before=await page.screenshot({clip});const start=Date.now();
        await toggle.click();await page.waitForFunction(id=>document.querySelector(`[data-service="${id}"]`)?.dataset.renderStatus==='ready',id);
        r.changedPixels=0;
        while(r.changedPixels<=150&&Date.now()-start<20000){await page.waitForTimeout(250);r.changedPixels=changedPixels(before,await page.screenshot({clip}));}
        r.firstVisibleMs=Date.now()-start;
        assert(r.changedPixels>150,`First activation did not draw ${id}: ${r.changedPixels} pixels`);
        await page.screenshot({path:path.join(output,`reference-first-${mode}-${id}-${run+1}.png`)});
        for(const key of ['failures','httpErrors','consoleErrors','pageErrors','externalRequests'])assert.equal(r[key].length,0,JSON.stringify(r[key]));
        assert(r.cloudResponses.length>=8,'Initial cloud tile response set was not observed');
        r.passed=true;
      }catch(error){r.failure=String(error);await page.screenshot({path:path.join(output,`reference-first-failure-${run+1}.png`)}).catch(()=>{});}
      finally{await context.close();fs.writeFileSync(path.join(output,'reference-startup-validation.json'),JSON.stringify(report,null,2));}
    }
    report.passed=report.runs.every(r=>r.passed);
  }finally{await browser.close();fs.writeFileSync(path.join(output,'reference-startup-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;}
})();
