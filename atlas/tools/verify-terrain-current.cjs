const {chromium} = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const base = process.env.ATLAS_URL || 'http://127.0.0.1:8766';
const evidence = path.join(root, 'evidence');
const report = {date:new Date().toISOString(),base,checks:[],responses:[],consoleErrors:[],pageErrors:[],failedRequests:[]};
const check = (name, detail={}) => report.checks.push({name,passed:true,...detail});
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  // Read-only test probe into the original module store: verify the field actually
  // delivered to the particle renderer, including its untouched missing-data mask.
  await page.route('**/assets/earth-entry-S7CI26MD.js', async route => {
    const response = await route.fetch();
    const probe = '\nwindow.__atlasCurrentProof=()=>{const f=q.getState().fieldData;if(!f)return null;let valid=0,polarValid=0,invalidValues=0;for(let i=0;i<f.ocean.length;i++){if(f.ocean[i]){valid++;const lat=f.lat0+(Math.floor(i/f.width)+.5)*f.dLat;if(Math.abs(lat)>65)polarValid++;}else if(f.u[i]||f.v[i])invalidValues++;}return {width:f.width,height:f.height,valid,polarValid,invalidValues,simulated:f.simulated,timestamp:f.timestamp};};';
    await route.fulfill({response,body:(await response.text())+probe});
  });
  page.setDefaultTimeout(20000);
  let phase = 'online';
  page.on('console', message => {if (message.type()==='error') report.consoleErrors.push({phase,text:message.text()});});
  page.on('pageerror', error => report.pageErrors.push({phase,text:String(error)}));
  page.on('requestfailed', request => report.failedRequests.push({phase,url:request.url(),failure:request.failure()}));
  page.on('response', response => {
    if (/\/__local\/(?:terrain|currents)\//.test(response.url()) || response.status()>=400)
      report.responses.push({phase,url:response.url(),status:response.status()});
  });
  const button = label => page.locator('button').filter({hasText:label});
  async function layers() {
    await page.keyboard.press('Escape');
    await button(/^图层/).click();
    await button(/全部图层与来源/).click();
    await page.locator('[data-service="currents"]').waitFor();
  }
  async function home() {
    await page.goto(base+'/?view=globe&from=solar');
    await page.locator('.cesium-widget canvas').waitFor({timeout:30000});
    await page.waitForTimeout(1400);
  }
  async function fly(coordinates) {
    await page.keyboard.press('Escape');
    const search = page.getByPlaceholder('搜索地球');
    await search.fill(coordinates);
    await search.press('Enter');
    await page.waitForTimeout(2500);
  }
  async function json(url) {
    const response = await page.request.get(base+url);
    assert(response.ok(),url+' HTTP '+response.status());
    return response.json();
  }
  async function shot(name) {await page.screenshot({path:path.join(evidence,name+'.png')});}
  try {
    await home();
    await layers();
    await page.waitForFunction(()=>document.querySelector('[data-service="currents"]')?.dataset.simulated==='false');
    let currents = await json('/__local/currents/manifest.json?offline=1');
    // A public source may publish a new daily analysis during the test. Reload
    // once if the initial bundled snapshot has already been superseded.
    if (!(await page.locator('[data-service="currents"]').innerText()).includes(currents.validTime)) {
      await home(); await layers();
    }
    await page.waitForFunction(date=>document.querySelector('[data-service="currents"]')?.innerText.includes(date),currents.validTime);
    const detail = await page.locator('[data-service="currents"]').innerText();
    assert(detail.includes(currents.validTime));
    assert(detail.includes('地转') && detail.includes('缺测') && detail.includes('延迟'));
    assert(currents.simulated===false && currents.validCells>10000 && currents.missingCells>0);
    check('Original field renderer loads genuine NOAA geostrophic data with original date and limitations', {detail,validTime:currents.validTime,validCells:currents.validCells});
    const binaryResponse = await page.request.get(base+currents.file);
    assert(binaryResponse.ok());
    const binary = await binaryResponse.body();
    assert.strictEqual(crypto.createHash('sha256').update(binary).digest('hex'),currents.sha256);
    assert.strictEqual(binary.toString('ascii',0,4),'OACF');
    assert.strictEqual(currents.units.u,'m/s eastward');
    assert.strictEqual(currents.units.v,'m/s northward');
    assert.strictEqual(binary.readDoubleLE(26),Date.parse(currents.validTime));
    const width=binary.readUInt16LE(6),height=binary.readUInt16LE(8),count=width*height;
    let offset=36+binary.readUInt16LE(34);offset+=2+binary.readUInt16LE(offset);offset++;
    const mask=binary.subarray(offset+count*4);
    assert.strictEqual(mask.length,count);
    assert.strictEqual([...mask].reduce((sum,value)=>sum+value,0),currents.validCells);
    const renderedField=await page.evaluate(()=>window.__atlasCurrentProof());
    assert.strictEqual(renderedField.valid,currents.validCells,'Renderer mask was overwritten by the base ocean mask');
    assert.strictEqual(renderedField.polarValid,0);
    assert.strictEqual(renderedField.invalidValues,0);
    assert.strictEqual(renderedField.simulated,false);
    check('Actual rendered OACF field retains exact source mask, units and checksum; no invented polar vectors', {sha256:currents.sha256,renderedField,missingCells:currents.missingCells});
    const currentToggle = page.getByRole('switch',{name:/^地转洋流/});
    await currentToggle.click();
    assert(await currentToggle.getAttribute('aria-checked')==='true');
    await page.keyboard.press('Escape');
    assert((await page.locator('.current-legend').innerText()).includes('地转洋流 · 卫星派生分析'));
    const timeline=page.locator('.timeline-toggle');
    assert((await timeline.innerText()).includes(currents.validTime.slice(0,10)));
    await timeline.click();
    assert((await page.locator('.timeline-content').innerText()).includes('播放不会改变数据日期或预测未来'));
    assert.strictEqual(await page.locator('.timeline input[type="range"]').count(),0);
    await page.getByRole('button',{name:'暂停动画',exact:true}).click();
    await page.getByRole('button',{name:'播放动画',exact:true}).click();
    await timeline.click();
    check('Current legend and controls show the genuine analysis date, with animation pause/play and no false forecast slider');
    await page.waitForTimeout(2300);
    const first = await page.locator('.cesium-widget canvas').screenshot();
    await page.waitForTimeout(1250);
    const second = await page.locator('.cesium-widget canvas').screenshot();
    assert(!first.equals(second),'Current field canvas frames are identical');
    await shot('services-geostrophic-currents');
    check('NOAA current particles animate in the original Cesium canvas', {framesDiffer:true});
    await layers();
    await currentToggle.click();
    const terrainToggle = page.getByRole('switch',{name:/^真实三维地形/});
    assert(await terrainToggle.isEnabled());
    await terrainToggle.click();
    await fly('27.9881,86.9250');
    await page.waitForFunction(()=>/高程\s*[1-9][\d,.]*\s*km/.test(document.body.innerText),{},{timeout:25000});
    const nearText = await page.locator('body').innerText();
    assert(report.responses.some(r=>r.url.includes('/__local/terrain/')&&r.status===200));
    const tileUrl=report.responses.find(r=>r.url.includes('/__local/terrain/14/')&&r.status===200).url;
    const elevations=await page.evaluate(async url=>{
      const response=await fetch(url+'?offline=1');
      const bitmap=await createImageBitmap(await response.blob());
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let min=Infinity,max=-Infinity,sum=0;
      for(let i=0;i<pixels.length;i+=4){const meters=pixels[i]*256+pixels[i+1]+pixels[i+2]/256-32768;min=Math.min(min,meters);max=Math.max(max,meters);sum+=meters;}
      return {width:bitmap.width,height:bitmap.height,min,max,mean:sum/(pixels.length/4)};
    },tileUrl);
    assert(elevations.width===256&&elevations.height===256);
    assert(elevations.min>3000&&elevations.max<9000&&elevations.max-elevations.min>100);
    check('Fetched Terrarium mountain tile decodes to varied real elevations rather than a flat canvas', {tileUrl,elevations});
    // A wider tilted view makes the height geometry visible with the saved coarse imagery.
    for(let i=0;i<5;i++){await page.getByLabel('缩小地球',{exact:true}).click();await page.waitForTimeout(280);}
    const tilt=page.getByLabel('切换俯视与倾斜视角',{exact:true});
    if ((await tilt.innerText()).trim()==='3D') await tilt.click();
    await page.waitForTimeout(6500);
    await shot('services-himalaya-terrain');
    check('Real heightmap tiles load near Everest and produce nonzero elevation', {detail:nearText,successfulTiles:report.responses.filter(r=>r.url.includes('/__local/terrain/')&&r.status===200).length,imageryLimitation:'Saved local imagery is coarse at close range; terrain heights are genuine.'});
    await layers();
    await page.getByRole('checkbox',{name:'自动更新数据',exact:true}).uncheck();
    await page.waitForTimeout(1000);
    phase='offline-cache';
    await home();
    await layers();
    await page.waitForFunction(()=>document.querySelector('[data-service="currents"]')?.dataset.simulated==='false');
    currents=await json('/__local/currents/manifest.json?offline=1');
    await page.waitForFunction(date=>document.querySelector('[data-service="currents"]')?.innerText.includes(date),currents.validTime);
    assert((await page.locator('[data-service="currents"]').innerText()).includes(currents.validTime));
    check('Explicit offline reload retains true current analysis rather than simulation');
    await page.getByRole('switch',{name:/^真实三维地形/}).click();
    const before = await json('/__local/terrain/status');
    await fly('27.9881,86.9250');
    await page.waitForTimeout(4500);
    assert(report.responses.some(r=>r.phase==='offline-cache'&&r.url.includes('offline=1')&&r.status===200));
    await shot('services-terrain-offline-cache');
    check('Visited mountain tiles reload from server cache with offline=1');
    phase='offline-missing';
    await fly('-32.6532,-70.0109');
    await page.waitForTimeout(4000);
    assert(report.responses.some(r=>r.phase==='offline-missing'&&r.url.includes('offline=1')&&r.status===204));
    assert((await page.locator('body').innerText()).includes('地形'));
    assert(await page.locator('.cesium-widget canvas').isVisible());
    await page.getByLabel('缩小地球',{exact:true}).click();
    await page.waitForTimeout(700);
    const after = await json('/__local/terrain/status');
    assert(after.downloadedThisRun===before.downloadedThisRun,'Offline navigation downloaded upstream tiles');
    await shot('services-terrain-offline-fallback');
    check('Unvisited offline regions show explicit terrain fallback while globe navigation survives', {upstreamDownloadsBefore:before.downloadedThisRun,upstreamDownloadsAfter:after.downloadedThisRun,unavailableTiles:report.responses.filter(r=>r.phase==='offline-missing'&&r.status===204).length});
    assert(report.consoleErrors.length===0,JSON.stringify(report.consoleErrors));
    assert(report.pageErrors.length===0,JSON.stringify(report.pageErrors));
    assert(!report.responses.some(r=>r.status>=400),JSON.stringify(report.responses.filter(r=>r.status>=400)));
    check('Online, cached offline and missing offline terrain have no console/page errors or HTTP failures');
    report.passed=true;
  } catch(error) {
    report.passed=false;report.failure=String(error);report.stack=error.stack;
    try{report.body=await page.locator('body').innerText();await shot('services-terrain-current-failure');}catch{}
  } finally {
    fs.writeFileSync(path.join(evidence,'terrain-current-browser.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:report.passed,checks:report.checks,failure:report.failure,errorCount:report.consoleErrors.length+report.pageErrors.length}));
    await browser.close();
    if(!report.passed)process.exitCode=1;
  }
})();
