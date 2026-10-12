// Global model grids reuse the original atlas decoder and renderers.
const preferenceKey = 'atlas.weather.online';
function onlinePreference() {
  if (new URLSearchParams(location.search).get('weather') === 'offline') return false;
  try { return localStorage.getItem(preferenceKey) !== 'false'; } catch { return true; }
}

export function createWeatherState(set, get, {decodeGrid, loadBinary}) {
  let pending = null;
  let refreshPoll = null;
  let capability;
  let capabilityCheckedAt = 0;
  let autoOwners = 0;
  let stopAuto = null;
  let autoGeneration = 0;
  async function hasBackend() {
    if (capability === true || (capability === false && Date.now() - capabilityCheckedAt < 60000)) return capability;
    try {
      const response = await fetch('/', {cache: 'no-store', signal: AbortSignal.timeout(5000)});
      await response.text(); // Consume the small HTML shell; no script is executed.
      capability = response.headers.get('X-Atlas-Live-Weather') === '1';
    } catch { capability = false; }
    capabilityCheckedAt = Date.now();
    set({backendAvailable: capability});
    return capability;
  }
  async function gridFrom(url) {
    const response = await fetch(url, {cache: 'no-store', signal: AbortSignal.timeout(20000)});
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Error('Forecast metadata unavailable');
    const meta = await response.json();
    const previous = get().grid;
    const grid = previous && previous.binary === meta.binary && previous.downloadedAt === meta.downloadedAt
      ? {...previous, ...meta} : decodeGrid(meta, await loadBinary(meta.binary, meta.binaryParts));
    if (meta.cloudBinary && !grid.clouds) {
      const buffer = await loadBinary(meta.cloudBinary, meta.cloudBinaryParts);
      if (buffer.byteLength !== grid.width * grid.height * 4) throw Error('Invalid cloud grid');
      const clouds = new Float32Array(buffer);
      if (clouds.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw Error('Invalid cloud values');
      grid.clouds = clouds;
    }
    return grid;
  }
  function load(options = {}) {
    if (pending) return pending;
    clearTimeout(refreshPoll);
    const enabled = get().liveEnabled;
    const networkAvailable = globalThis.navigator?.onLine !== false;
    let allowRemote = enabled && networkAvailable;
    const owningGeneration = autoOwners ? autoGeneration : null;
    if (options.force) capability = undefined;
    pending = (async () => {
      set({state: get().grid ? 'ready' : 'loading', refreshing: true, updateError: null, networkAvailable});
      try {
        // Paint the genuine bundled snapshot immediately during a first online update.
        if (!get().grid) {
          const snapshot = await gridFrom('/weather/gfs-surface.json');
          set({grid: snapshot, state: 'ready'});
        }
        const backend = await hasBackend();
        if (enabled !== get().liveEnabled) return;
        allowRemote &&= globalThis.navigator?.onLine !== false && get().networkAvailable !== false;
        if (backend) {
          if (allowRemote && options.force) {
            const response = await fetch('/__local/weather/refresh', {method: 'POST', signal: AbortSignal.timeout(10000)});
            if (!response.ok) throw Error('Weather refresh unavailable');
          }
          allowRemote &&= globalThis.navigator?.onLine !== false && get().networkAvailable !== false;
          const grid = await gridFrom('/__local/weather/gfs-surface.json' + (allowRemote ? '' : '?offline=1'));
          if (enabled !== get().liveEnabled) return;
          const status = grid.weatherStatus || {};
          set({grid, points: [], state: 'ready', online: allowRemote && globalThis.navigator?.onLine !== false && get().networkAvailable !== false && grid.online === true,
            weatherStatus: status, updateError: status.error || null, lastChecked: Date.now()});
        } else {
          const snapshot = await gridFrom('/weather/gfs-surface.json');
          set({grid: snapshot, points: [], state: 'ready', online: false,
            weatherStatus: {mode: 'snapshot'}, lastChecked: Date.now()});
        }
      } catch (error) {
        set({state: get().grid ? 'ready' : 'error', online: false, updateError: String(error.message || error),
          weatherStatus: {...get().weatherStatus, refreshing: false}, lastChecked: Date.now()});
      } finally {
        set({refreshing: false});
        pending = null;
        // A manual update may be started while all analysis layers are off.
        // Finish monitoring that job independently of the globe layer lifecycle.
        const lifecycleActive = owningGeneration === null || (autoOwners > 0 && owningGeneration === autoGeneration);
        if (lifecycleActive && get().liveEnabled && globalThis.navigator?.onLine !== false && get().weatherStatus.refreshing) refreshPoll = setTimeout(() => load(), 2000);
      }
    })();
    return pending;
  }

  function startAutoUpdate() {
    autoOwners += 1;
    if (!stopAuto) {
      autoGeneration += 1;
      let lastAttempt = -Infinity;
      let wakeTimer = null;
      let wakeReconnect = false;
      const attempt = (reconnect = false) => {
        if (document.hidden) return;
        if (globalThis.navigator?.onLine === false || !get().liveEnabled) {
          if (!get().grid) load();
          return;
        }
        if (Date.now() - lastAttempt < 10000) return;
        lastAttempt = Date.now();
        // Only a failed update needs a forced reconnect attempt. The server
        // still enforces its minimum interval and its source's hourly cadence.
        load({force: reconnect && !!get().updateError});
      };
      const schedule = (reconnect = false) => {
        clearTimeout(wakeTimer);
        wakeReconnect ||= reconnect;
        wakeTimer = setTimeout(() => {
          const reconnect = wakeReconnect;
          wakeReconnect = false;
          attempt(reconnect);
        }, 250);
      };
      const visible = () => { if (!document.hidden) schedule(); };
      const focus = () => schedule();
      const online = () => {
        if (!get().networkAvailable) lastAttempt = -Infinity;
        set({networkAvailable: true});
        schedule(true);
      };
      const offline = () => {
        clearTimeout(wakeTimer);
        wakeReconnect = false;
        clearTimeout(refreshPoll);
        set({networkAvailable: false, online: false});
      };
      document.addEventListener('visibilitychange', visible);
      window.addEventListener('focus', focus);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      // Metadata is small; unchanged grids are reused without downloading
      // binary files. The server alone decides when new upstream data is due.
      const timer = setInterval(() => attempt(), 60000);
      if (!document.hidden) {
        lastAttempt = Date.now();
        load(); // Opening Earth is sufficient, even with every weather layer off.
      }
      stopAuto = () => {
        clearInterval(timer);
        clearTimeout(wakeTimer);
        clearTimeout(refreshPoll);
        document.removeEventListener('visibilitychange', visible);
        window.removeEventListener('focus', focus);
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offline);
      };
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--autoOwners === 0) { autoGeneration += 1; stopAuto(); stopAuto = null; }
    };
  }
  return {
    grid: null, points: [], state: 'idle', refreshing: false, online: false, lastChecked: 0,
    liveEnabled: onlinePreference(), backendAvailable: null, weatherStatus: {}, updateError: null,
    networkAvailable: globalThis.navigator?.onLine !== false,
    point: {lon: 65, lat: -12},
    inspect: (lon, lat) => set({point: {lon: ((lon + 180) % 360 + 360) % 360 - 180, lat: Math.max(-90, Math.min(90, lat))}}),
    setLiveEnabled(enabled) {
      try { localStorage.setItem(preferenceKey, String(enabled)); } catch {}
      set({liveEnabled: enabled, online: false});
      // A running request checks the preference before publishing a result.
      (pending || Promise.resolve()).finally(() => load());
    },
    load, startAutoUpdate,
  };
}
