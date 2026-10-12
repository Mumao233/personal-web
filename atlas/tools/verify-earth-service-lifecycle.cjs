/* Isolated deterministic lifecycle checks. All HTTP/Cesium/data fixtures are
 * mocked, no browser or real network, no changes to production data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const earthSource = fs.readFileSync(path.join(root, 'assets/earth-services.js'), 'utf8')
  .replace(/^import .*;\r?\n/m, '').replaceAll('export function ', 'function ');
const currentSource = fs.readFileSync(path.join(root, 'assets/current-data.js'), 'utf8')
  .replaceAll('export function ', 'function ');
const report = {runAt:new Date().toISOString(),
  method:'Node VM with controlled deferred promises, mocked HTTP/Cesium and explicitly synthetic transport fixtures; no live data assertions', checks:[]};

function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function settle() {for(let i=0;i<100;i++) await Promise.resolve();}
function events() {
  const listeners=new Map();
  return {listeners,
    addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener:(type,fn)=>listeners.get(type)?.delete(fn),
    emit:(type)=>{for(const fn of [...listeners.get(type)||[]])fn({type});}};
}
function store(initial) {
  let state=initial;const listeners=new Set();
  return {getState:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    set:patch=>{const previous=state;state={...state,...patch};for(const fn of listeners)fn(state,previous);},
    listenerCount:()=>listeners.size};
}
function response(body,backend=true) {return {ok:true,status:200,
  json:async()=>structuredClone(body),text:async()=>'<html>test fixture</html>',
  headers:{get:name=>name==='X-Atlas-Live-Weather'&&backend?'1':null}};}
function oceanMeta(id='sst',version='1') {
  const hash=version.repeat(64);
  return {id,available:true,state:'live',imageSha256:hash,legendSha256:'a'.repeat(64),
    validDate:'2026-10-10',credit:'Test fixture only',
    imageUrl:'/__local/ocean/'+id+'/image.png?v='+hash.slice(0,16),
    legendUrl:'/__local/ocean/'+id+'/legend.png?v='+'a'.repeat(16)};
}
function environment({connected=true,enabled=true,networkAvailable=true,hidden=false,fetchHandler}={}) {
  const window=events(),document={...events(),hidden},navigator={onLine:connected};
  const timers=new Map(),requests=[];let timer=0;
  const sandbox={URL,console,queueMicrotask,Date,document,navigator,window,
    location:{href:'http://test.invalid/?view=globe'},AbortSignal:{timeout:()=>({})},
    setInterval:(fn,ms)=>{const id=++timer;timers.set(id,{fn,ms});return id;},
    clearInterval:id=>timers.delete(id),
    fetch:async(url,options)=>{requests.push({url,options});const custom=fetchHandler&&fetchHandler(url,options);if(custom!==undefined)return custom;
      if(url==='/')return response(null);
      const match=url.match(/\/ocean\/([^/]+)\/(?:metadata|metadata.json)/);
      if(match)return response({...oceanMeta(match[1]),state:url.includes('offline=1')?'cache':'live'});
      throw Error('Unexpected fixture URL: '+url);}};
  vm.createContext(sandbox);
  const weather=store({liveEnabled:enabled,networkAvailable});
  return {sandbox,window,document,navigator,timers,requests,weather,
    listeners:()=>[...window.listeners.values(),...document.listeners.values()].reduce((sum,set)=>sum+set.size,0)};
}
function earthHarness(options={}) {
  const h=environment(options),layers=store({layers:{sst:!!options.enabledLayer}});
  const imagery=[],added=[],removed=[],providerCalls=[];let referenceDestroyed=0;
  const viewer={isDestroyed:()=>false,scene:{requestRender(){}},imageryLayers:{
    addImageryProvider(provider){const layer={provider,show:true};imagery.push(layer);added.push(layer);return layer;},
    remove(layer){const i=imagery.indexOf(layer);if(i>=0)imagery.splice(i,1);removed.push(layer);}}};
  const Cesium={Rectangle:{MAX_VALUE:{}},Credit:class {constructor(text){this.text=text;}},
    SingleTileImageryProvider:{fromUrl:async(url)=>{providerCalls.push(url);return options.providerHandler?options.providerHandler(url):{url};}}};
  h.sandbox.attachReferenceLayers=()=>({setEnabled(){},destroy(){referenceDestroyed++;}});
  vm.runInContext(earthSource+'\nglobalThis.attach=attachEarthServices;globalThis.status=()=>serviceState;globalThis.inject=(id,meta)=>publish(id,meta);',h.sandbox);
  const dispose=h.sandbox.attach(Cesium,viewer,layers,h.weather);
  return {...h,layers,imagery,added,removed,providerCalls,dispose,status:h.sandbox.status,inject:h.sandbox.inject,
    referenceDestroyed:()=>referenceDestroyed};
}
function currentFixture({hash='1',mode='online',error=null}={}) {
  return {field:{testFixture:true,source:'Synthetic test transport fixture'},
    manifest:{sha256:hash.repeat(64),source:'Synthetic test transport fixture',simulated:false,
      validTime:'2026-10-10T00:00:00Z',downloadedAt:'2026-10-12T06:00:00Z',resolution:'fixture',
      currentStatus:{mode,error}}};
}
function currentHarness(options={}) {
  const h=environment(options),fieldCalls=[],fieldPatches=[],health=[],loads=[];
  const state={fieldData:null,field:{},setFieldData(value){state.fieldData=value;},
    setFieldInfo(patch){state.field={...state.field,...patch};fieldPatches.push(patch);},
    setDataHealth(...args){health.push(args);}};
  const globe={getState:()=>state};
  const loadField=async url=>{loads.push(url);return options.loadHandler?options.loadHandler(url):currentFixture();};
  vm.runInContext(currentSource+'\nglobalThis.start=startCurrentData;',h.sandbox);
  const dispose=h.sandbox.start(globe,h.weather,loadField,value=>fieldCalls.push(value),
    ()=>({source:'Simulated test fallback',simulated:true}),async()=>({testFixture:true}),()=>{});
  return {...h,dispose,loads,state,fieldCalls,fieldPatches,health};
}
async function check(name,fn) {try{await fn();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:error.stack});console.error(name+': '+error.message);}}

(async()=>{
  await check('ocean respects store networkAvailable=false even when navigator says online',async()=>{
    const h=earthHarness({networkAvailable:false});await settle();
    const requests=h.requests.filter(r=>r.url.includes('/metadata'));
    assert.equal(requests.length,3);assert(requests.every(r=>r.url.endsWith('?offline=1')));h.dispose();
  });
  await check('ocean pending off/on changes coalesce into exactly one follow-up poll',async()=>{
    const held=deferred();let count=0;
    const h=earthHarness({fetchHandler:url=>url.includes('/metadata')&&++count<=3?held.promise:undefined});
    await settle();h.weather.set({liveEnabled:false});h.weather.set({liveEnabled:true});
    held.resolve(response(oceanMeta()));await settle();
    assert.equal(h.requests.filter(r=>r.url.includes('/metadata')).length,6);
    assert.equal(h.timers.size,1);h.dispose();assert.equal(h.timers.size,0);assert.equal(h.listeners(),0);
  });
  await check('ocean offline change during pending load queues offline-only metadata',async()=>{
    const held=deferred();let count=0;
    const h=earthHarness({fetchHandler:url=>url.includes('/metadata')&&++count<=3?held.promise:undefined});
    await settle();h.weather.set({liveEnabled:false});held.resolve(response(oceanMeta()));await settle();
    const calls=h.requests.filter(r=>r.url.includes('/metadata'));assert.equal(calls.length,6);
    assert(calls.slice(3).every(r=>r.url.endsWith('?offline=1')));assert.equal(h.status().sst.state,'cache');h.dispose();
  });
  await check('ocean dispose during backend discovery prevents late metadata requests',async()=>{
    const held=deferred();const h=earthHarness({fetchHandler:url=>url==='/'?held.promise:undefined});
    await settle();h.dispose();held.resolve(response(null));await settle();
    assert.equal(h.requests.length,1);assert.equal(h.timers.size,0);assert.equal(h.listeners(),0);
    assert.equal(h.referenceDestroyed(),1);assert.equal(h.added.length,0);
  });
  await check('ocean dispose during metadata ignores late publication and queued work',async()=>{
    const held=deferred();const h=earthHarness({enabledLayer:true,fetchHandler:url=>url.includes('/metadata')?held.promise:undefined});
    await settle();h.weather.set({liveEnabled:false});h.dispose();const calls=h.requests.length;
    held.resolve(response(oceanMeta()));await settle();
    assert.equal(h.requests.length,calls);assert.equal(Object.keys(h.status()).length,0);
    assert.equal(h.added.length,0);assert.equal(h.timers.size,0);assert.equal(h.listeners(),0);
  });
  await check('ocean static server fallback keeps true snapshot label and static hash URL',async()=>{
    const h=earthHarness({enabledLayer:true,fetchHandler:url=>url==='/'?response(null,false):undefined});await settle();
    assert.equal(h.status().sst.state,'snapshot');assert.equal(h.status().sst.backend,false);
    assert(h.providerCalls[0].startsWith('http://test.invalid/data/ocean/sst/image.png?v='));
    assert(!h.requests.some(r=>r.url.startsWith('/__local/ocean/')));h.dispose();
  });
  await check('late failure from superseded ocean provider cannot overwrite newer ready layer',async()=>{
    const first=deferred();const h=earthHarness({enabledLayer:true,
      providerHandler:url=>url.includes('v='+'1'.repeat(16))?first.promise:{url}});
    await settle();h.inject('sst',oceanMeta('sst','2'));
    h.layers.set({layers:{sst:false}});h.layers.set({layers:{sst:true}});await settle();
    assert.equal(h.status().sst.renderStatus,'ready');assert.equal(h.imagery.length,1);
    first.reject(Error('controlled obsolete provider failure'));await settle();
    assert.equal(h.status().sst.renderStatus,'ready');assert.equal(h.status().sst.renderError,null);h.dispose();
  });
  await check('ocean layer switched off before image arrives remains hidden',async()=>{
    const held=deferred();const h=earthHarness({enabledLayer:true,providerHandler:()=>held.promise});
    await settle();h.layers.set({layers:{sst:false}});held.resolve({fixture:true});await settle();
    assert.equal(h.imagery.length,1);assert.equal(h.imagery[0].show,false);h.dispose();assert.equal(h.imagery.length,0);
  });
  await check('current service honors networkAvailable=false without remote refresh permission',async()=>{
    const h=currentHarness({networkAvailable:false});await settle();
    assert(h.loads.includes('/__local/currents/manifest.json?offline=1'));
    assert.equal(h.state.field.mode,'CACHED / GEOSTROPHIC');h.dispose();
  });
  await check('current pending off/on changes queue one new request and retain one timer',async()=>{
    const held=deferred();let remote=0;
    const h=currentHarness({loadHandler:url=>url.startsWith('/__local/')&&++remote===1?held.promise:currentFixture()});
    await settle();h.weather.set({liveEnabled:false});h.weather.set({liveEnabled:true});held.resolve(currentFixture());await settle();
    assert.equal(h.loads.filter(url=>url.startsWith('/__local/')).length,2);
    assert.equal(h.timers.size,1);h.dispose();assert.equal(h.timers.size,0);assert.equal(h.listeners(),0);
  });
  await check('current dispose during archive promise suppresses fields and future requests',async()=>{
    const held=deferred();const h=currentHarness({loadHandler:()=>held.promise});await settle();
    h.weather.set({liveEnabled:false});h.dispose();held.resolve(currentFixture());await settle();
    assert.equal(h.fieldCalls.length,0);assert.equal(h.requests.length,0);assert.equal(h.loads.length,1);
    assert.equal(h.timers.size,0);assert.equal(h.listeners(),0);
  });
  await check('current dispose during backend discovery suppresses late remote reads',async()=>{
    const held=deferred();const h=currentHarness({fetchHandler:url=>url==='/'?held.promise:undefined});await settle();
    h.dispose();const fields=h.fieldCalls.length;held.resolve(response(null));await settle();
    assert.equal(h.loads.length,1);assert.equal(h.fieldCalls.length,fields);assert.equal(h.timers.size,0);
  });
  await check('current failed upstream cache is never relabelled online merely because switch is on',async()=>{
    const h=currentHarness({loadHandler:url=>currentFixture(url.startsWith('/__local/')?{mode:'cached',error:'source offline'}:{})});
    await settle();assert.equal(h.state.field.mode,'CACHED / GEOSTROPHIC');
    assert.equal(h.state.field.currentStatus.error,'source offline');assert.equal(h.health.at(-1)[0],'STALE');h.dispose();
  });
  const file=path.join(root,'evidence/earth-service-lifecycle.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(report,null,2));
  const passed=report.checks.filter(c=>c.passed).length;console.log(`${passed}/${report.checks.length} lifecycle checks passed; ${file}`);
  if(passed!==report.checks.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
