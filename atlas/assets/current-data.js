// Feed a genuine satellite-derived field into the original OACF decoder and particle renderer.
export function startCurrentData(store, weatherStore, loadField, setField, createFallback, loadMask, applyMask) {
  let disposed = false, pending = false, queued = false, backend = false, backendChecked = 0, lastHash = null;
  const online = () => weatherStore.getState().liveEnabled && weatherStore.getState().networkAvailable !== false && navigator.onLine !== false && !document.hidden;
  function accept({field,manifest}, mode) {
    if (disposed) return;
    if (!lastHash || lastHash !== manifest.sha256) {
      setField(field); store.getState().setFieldData(field); lastHash = manifest.sha256;
    }
    const state = manifest.currentStatus || {};
    store.getState().setFieldInfo({source:manifest.source,simulated:false,status:'DERIVED',
      mode: mode === 'online' && state.mode === 'online' && !state.error ? 'SATELLITE / GEOSTROPHIC' : 'CACHED / GEOSTROPHIC',
      timestamp:Date.parse(manifest.validTime),updatedAt:Date.parse(manifest.downloadedAt),
      latencyMin:Math.max(0,(Date.now()-Date.parse(manifest.validTime))/60000),
      resolution:manifest.resolution, currentStatus:state, currentMetadata:manifest});
    store.getState().setDataHealth(state.error ? 'STALE' : 'OK', state.error || null);
  }
  async function load() {
    if (disposed) return;
    if (pending) {queued = true; return;}
    pending = true;
    try {
      // An unavailable bundled file must not prevent recovery from a valid local backend cache.
      let snapshotError = null;
      if (!lastHash) {
        try {accept(await loadField('/data/services-current/manifest.json'), 'snapshot');}
        catch(error) {snapshotError = error;}
      }
      if (disposed) return;
      if (!backend && Date.now()-backendChecked > 60000) {
        backendChecked=Date.now();
        try { const r = await fetch('/',{cache:'no-store',signal:AbortSignal.timeout(5000)}); await r.text(); backend=r.headers.get('X-Atlas-Live-Weather')==='1'; } catch {}
      }
      if (backend && !disposed) {
        const enabled = weatherStore.getState().liveEnabled;
        const loaded = await loadField('/__local/currents/manifest.json'+(online()?'':'?offline=1'));
        if (!disposed && enabled === weatherStore.getState().liveEnabled) accept(loaded, online()?'online':'cache');
      }
      if (snapshotError && !store.getState().fieldData) throw snapshotError;
    } catch(error) {
      if (disposed) return;
      store.getState().setDataHealth('STALE', String(error.message || error));
      // A damaged installation can still open the globe; that fallback stays explicitly simulated.
      if (!store.getState().fieldData) {
        const fallback = createFallback();
        const mask = await loadMask().catch(() => null);
        if (disposed) return;
        applyMask(fallback, mask); setField(fallback); store.getState().setFieldData(fallback);
        store.getState().setFieldInfo({source:fallback.source,simulated:true,status:'SIMULATED',mode:'FALLBACK / SYNTHETIC',timestamp:fallback.timestamp,resolution:fallback.resolution});
      }
    } finally {pending=false;if(queued&&!disposed){queued=false;queueMicrotask(load);}}
  }
  const wake = () => {if (online()) load();};
  const interval=setInterval(wake,60000);
  const unsubscribe=weatherStore.subscribe((next,previous)=>{if(next.liveEnabled!==previous.liveEnabled||next.networkAvailable!==previous.networkAvailable)load();});
  window.addEventListener('online',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  load();
  return ()=>{disposed=true;clearInterval(interval);unsubscribe();window.removeEventListener('online',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
}
