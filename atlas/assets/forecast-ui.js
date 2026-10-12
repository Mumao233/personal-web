// React is supplied by the original build, keeping one React instance and its UI styles.
export function createWeatherUI({React, jsx, jsxs, useTranslation, store, formatTime, fetchPointForecast}) {
  const element = (tag, props, ...children) => jsxs(tag, {...props, children});
  const number = (value, unit, t) => Number.isFinite(value) ? `${value.toFixed(2)} ${unit}` : t('此处无数据', 'No data at this location');
  const time = value => value ? formatTime(value) : '—';
  function WeatherControls() {
    const {t} = useTranslation();
    const s = store();
    const status = s.weatherStatus || {};
    const updating = s.refreshing || status.refreshing;
    const snapshot = !s.grid?.binary?.startsWith('/__local/');
    return element('section', {className: 'atlas-weather-controls', 'aria-label': t('自动数据服务', 'Automatic data services')},
      element('h3', {}, t('自动更新数据', 'Automatic data updates')),
      element('label', {className: 'atlas-weather-toggle'},
        jsx('input', {type: 'checkbox', checked: s.liveEnabled, onChange: e => s.setLiveEnabled(e.target.checked)}),
        t('自动更新数据', 'Automatically update data')),
      element('p', {className: 'panel__hint', role: 'status'},
        !s.liveEnabled ? t('离线模式 · 使用已保存数据', 'Offline mode · Saved data') :
        s.networkAvailable === false ? t('网络已断开 · 使用已保存数据', 'Network disconnected · Saved data') :
        updating ? t('正在检查全球风、降水和云量…', 'Checking global wind, rain and cloud cover…') :
        s.updateError ? t('更新暂未成功 · 保留已保存数据', 'Update unavailable · Keeping saved data') :
        s.backendAvailable === false ? t('当前启动方式仅支持选点联网预报；全球更新请使用 start.bat。', 'Point forecasts are online; use start.bat for global updates.') :
        snapshot ? t('全球图层 · 存档快照', 'Global layers · Archived snapshot') :
        status.mode === 'cached' ? t('全球图层 · 缓存 GFS 预报', 'Global layers · Cached GFS forecast') :
        t('全球图层 · 最新取得的 GFS 预报', 'Global layers · Latest fetched GFS forecast'),
        jsx('br', {}), t('有效时间：', 'Valid: '), time(s.grid?.validTime),
        jsx('br', {}), t('取得时间：', 'Fetched: '), time(s.grid?.downloadedAt)),
      element('button', {type: 'button', className: 'tag', disabled: !s.liveEnabled || updating,
        onClick: () => s.load({force: true}), 'data-action': 'refresh-global-weather'}, t('更新全球气象', 'Update global weather')),
      element('p', {className: 'panel__hint'}, t('打开地球后自动更新：天气每小时，海温、盐度、叶绿素及地转洋流每 6 小时检查。切回页面或恢复网络时自动检查；无须手动刷新。风、降水率和云量来自 NOAA GFS。摄影云层仍为存档影像；洋流动画使用 NOAA 地转洋流分析，选点海流使用模式预报。',
        'Updates start automatically on opening Earth: weather hourly; ocean products every 6 hours. Returning to the page or reconnecting checks again. No manual refresh needed. Wind, precipitation rate and cloud cover use NOAA GFS. Photographic clouds remain archived imagery. Current animation uses NOAA geostrophic analyses; point currents use model forecasts.')));
  }
  function SourceStatus({label, source}) {
    const {t} = useTranslation();
    const status = source?.status === 'online' ? t('在线预报', 'Online forecast') :
      source?.status === 'cached' ? t('缓存预报', 'Cached forecast') : t('暂不可用', 'Unavailable');
    return element('p', {className: 'panel__hint', 'data-source-status': source?.status || 'unavailable'},
      label, ' · ', status,
      source?.cacheReason === 'network-failure' ? t('（网络更新失败）', ' (network update failed)') : '',
      source?.dataStatus === 'no-data' ? t(' · 该位置无数据', ' · No data at this location') : '',
      jsx('br', {}), t('有效时间：', 'Valid: '), time(source?.validTime),
      jsx('br', {}), t('取得时间：', 'Fetched: '), time(source?.fetchedAt));
  }
  function PointForecastPanel() {
    const {t} = useTranslation();
    const point = store(s => s.point), enabled = store(s => s.liveEnabled);
    const [result, setResult] = React.useState(null), [state, setState] = React.useState('loading');
    const [revision, refresh] = React.useState(0), forced = React.useRef(false);
    const [lon, setLon] = React.useState(point.lon.toFixed(2)), [lat, setLat] = React.useState(point.lat.toFixed(2));
    const latest = React.useRef({result: null, state: 'loading', lastRequestAt: 0});
    latest.current.result = result;
    latest.current.state = state;
    React.useEffect(() => {
      if (!enabled) return;
      let pending = null, reconnect = false, disposed = false, lastRecoveryAt = 0;
      const usable = () => !disposed && !document.hidden && navigator.onLine !== false;
      const needsRecovery = () => latest.current.state === 'error' || !latest.current.result
        || Object.values(latest.current.result.sources || {}).some(source =>
          source.status === 'unavailable' || source.cacheReason === 'network-failure' || source.cacheReason === 'offline');
      const run = () => {
        pending = null;
        if (!usable()) return;
        // Finish the current request before a lifecycle event can trigger another.
        if (latest.current.state === 'loading') { pending = setTimeout(run, 1000); return; }
        const recover = reconnect && needsRecovery();
        const delay = 10000 - (Date.now() - (recover ? lastRecoveryAt : latest.current.lastRequestAt));
        if (delay > 0) { pending = setTimeout(run, delay); return; }
        reconnect = false;
        if (recover) { lastRecoveryAt = Date.now(); forced.current = true; }
        refresh(n => n + 1);
      };
      const schedule = event => {
        if (event?.type === 'online') reconnect = true;
        if (!usable()) return;
        clearTimeout(pending);
        // Visibility, focus and online often arrive together; coalesce the burst.
        pending = setTimeout(run, 300);
      };
      const timer = setInterval(schedule, 300000);
      document.addEventListener('visibilitychange', schedule);
      window.addEventListener('focus', schedule);
      window.addEventListener('online', schedule);
      return () => {
        disposed = true; clearInterval(timer); clearTimeout(pending);
        document.removeEventListener('visibilitychange', schedule);
        window.removeEventListener('focus', schedule);
        window.removeEventListener('online', schedule);
      };
    }, [enabled]);
    React.useEffect(() => {
      setLon(point.lon.toFixed(2)); setLat(point.lat.toFixed(2));
      setState('loading'); setResult(null);
      const controller = new AbortController();
      const force = forced.current; forced.current = false;
      latest.current.lastRequestAt = Date.now();
      fetchPointForecast(point.lon, point.lat, controller.signal, {force, offline: !enabled || navigator.onLine === false})
        .then(data => { if (!controller.signal.aborted) {setResult(data); setState('ready');} })
        .catch(() => { if (!controller.signal.aborted) setState('error'); });
      return () => controller.abort('unmount');
    }, [point.lon, point.lat, revision, enabled]);
    const query = event => {
      event.preventDefault();
      const x = Number(lon), y = Number(lat);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -85 || y > 85) return;
      forced.current = true;
      store.getState().inspect(x, y);
      // Longitude normalization can introduce floating-point differences.
      // An explicit submission must refresh even if the normalized point is unchanged.
      refresh(n => n + 1);
    };
    const row = (label, value, unit) => element('div', {}, element('dt', {}, label), element('dd', {}, number(value, unit, t)));
    return element('div', {className: 'atlas-point-forecast'},
      element('p', {}, t('点击地球选取位置，也可输入坐标。每 5 分钟检查一次最新预报。', 'Select a location on the globe or enter coordinates. Forecasts are checked every 5 minutes.')),
      element('form', {className: 'coordinate-form', onSubmit: query},
        element('label', {}, t('经度', 'Longitude'), jsx('input', {type: 'number', min: -180, max: 180, step: '.01', required: true, value: lon, onChange: e => setLon(e.target.value)})),
        element('label', {}, t('纬度', 'Latitude'), jsx('input', {type: 'number', min: -85, max: 85, step: '.01', required: true, value: lat, onChange: e => setLat(e.target.value)})),
        element('button', {type: 'submit', className: 'tag', disabled: state === 'loading'}, t('查询 / 刷新', 'Inspect / Refresh'))),
      state === 'loading' && element('p', {role: 'status'}, t('正在读取气象和海流预报…', 'Loading weather and current forecasts…')),
      state === 'error' && element('div', {className: 'notice', role: 'status'}, t('暂时无法取得该位置预报，也没有可用缓存。可重试，或查看已保存的全球气象图层。', 'No forecast or cached result is available here. Retry or view the saved global weather layers.')),
      result && element('section', {'aria-label': t('当前位置预报', 'Forecast at this location')},
        element('h3', {}, t('当前位置预报', 'Forecast at this location')),
        element('dl', {className: 'dossier__rows'},
          row(t('10 米风速', 'Wind at 10 m'), result.wind, 'm/s'),
          row(t('风的来向', 'Wind from'), result.direction, '°'),
          row(t(`近 ${Math.round((result.rainIntervalSeconds || 900) / 60)} 分钟降水`, `Precipitation · previous ${Math.round((result.rainIntervalSeconds || 900) / 60)} min`), result.rain, 'mm'),
          row(t('海表流速', 'Surface current'), result.current, 'm/s'),
          row(t('洋流流向', 'Current towards'), result.currentDirection, '°')),
        jsx(SourceStatus, {label: t('天气', 'Weather'), source: result.sources.weather}),
        jsx(SourceStatus, {label: t('海流', 'Currents'), source: result.sources.marine})),
      element('p', {className: 'panel__hint'}, t('Open-Meteo 数值模式预报；海流来自 Copernicus / Météo-France SMOC。非现场观测，内陆海流可能无数据。底部时间轴仅控制模拟洋流。', 'Open-Meteo model forecasts; currents from Copernicus / Météo-France SMOC. Not in-situ observations; inland currents may be unavailable. The timeline only controls simulated currents.')),
      element('a', {href: 'https://open-meteo.com/', target: '_blank', rel: 'noreferrer'}, 'Open-Meteo · CC BY 4.0'),
      jsx(WeatherControls, {}));
  }
  return {PointForecastPanel, WeatherControls};
}
