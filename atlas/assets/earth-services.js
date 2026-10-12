import {attachReferenceLayers} from './reference-layers.js';

const oceanIds = ['sst', 'salinity', 'chlorophyll'];
const referenceIds = ['plates', 'trenches', 'eez'];
const titles = {sst:'海表温度',salinity:'海表盐度',chlorophyll:'叶绿素 a'};
const info = {
  sst: {credit:'NASA GIBS / JPL / GHRSST MUR',units:'°C',aggregation:'每日海温分析；不是即时测量',aggregationEn:'Daily SST analysis; not instantaneous measurements'},
  salinity: {credit:'NASA GIBS / JPL / SMAP CAP',units:'PSU',aggregation:'8 日滑动平均；日期为产品标记日期',aggregationEn:'8-day running mean; date is the product label date'},
  chlorophyll: {credit:'NASA GIBS / Aqua MODIS',units:'mg/m³',aggregation:'卫星日影像；云遮挡和未观测处保持透明',aggregationEn:'Daily satellite imagery; unobserved areas stay transparent'}
};
let serviceState = {};
const subscribers = new Set();
function publish(id, patch) {
  serviceState = {...serviceState, [id]: {...serviceState[id], ...patch}};
  for (const notify of subscribers) notify(serviceState);
}
const activeNetwork = store => store.getState().liveEnabled && store.getState().networkAvailable !== false && navigator.onLine !== false && !document.hidden;

// Local metadata and genuine snapshots render immediately. The server bounds upstream updates.
export function attachEarthServices(Cesium, viewer, layersStore, weatherStore) {
  let disposed = false, pending = false, queuedPoll = false, backend = false, backendChecked = 0;
  const rendered = new Map(), generations = new Map();
  const references = attachReferenceLayers(Cesium, viewer);
  const render = () => {if (!disposed && !viewer.isDestroyed()) viewer.scene.requestRender();};
  function referenceEvent(event) { publish(event.detail.id, event.detail); }
  window.addEventListener('atlas-reference-status', referenceEvent);
  async function showOcean(id) {
    const wanted = !!layersStore.getState().layers[id];
    const old = rendered.get(id);
    if (old) old.layer.show = wanted;
    const meta = serviceState[id];
    if (!wanted || !meta?.available || disposed) {render(); return;}
    const version = meta.imageSha256 || meta.validDate;
    if (old?.version === version || generations.get(id)?.version === version) {render(); return;}
    const token = {version}; generations.set(id, token);
    publish(id, {renderStatus:'loading'});
    try {
      const imageUrl = new URL(meta.imageUrl, location.href);
      if (!imageUrl.searchParams.has('v')) imageUrl.searchParams.set('v', version.slice(0,16));
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(imageUrl.href, {
        rectangle: Cesium.Rectangle.MAX_VALUE, credit: new Cesium.Credit(meta.credit)
      });
      if (disposed || viewer.isDestroyed() || generations.get(id) !== token) return;
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      layer.show = !!layersStore.getState().layers[id];
      const previous = rendered.get(id);
      if (previous) viewer.imageryLayers.remove(previous.layer, true);
      rendered.set(id, {layer,version});
      publish(id, {renderStatus:'ready',renderError:null});
      render();
    } catch (error) {
      if (!disposed && generations.get(id) === token) publish(id, {renderStatus:'error',renderError:String(error.message || error)});
    } finally {if (generations.get(id) === token) generations.delete(id);}
  }
  async function json(url) {
    const response = await fetch(url, {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error('HTTP ' + response.status);
    return response.json();
  }
  async function poll() {
    if (disposed) return;
    if (pending) {queuedPoll = true; return;}
    pending = true;
    try {
      if (!backend && Date.now() - backendChecked > 60000) {
        backendChecked = Date.now();
        try { const r = await fetch('/', {cache:'no-store',signal:AbortSignal.timeout(5000)}); await r.text(); backend = r.headers.get('X-Atlas-Live-Weather') === '1'; } catch {}
      }
      if (disposed) return;
      await Promise.all(oceanIds.map(async id => {
        try {
          let meta;
          if (backend) meta = await json('/__local/ocean/' + id + '/metadata' + (activeNetwork(weatherStore) ? '' : '?offline=1'));
          else {
            meta = {...await json('/data/ocean/' + id + '/metadata.json'), ...info[id],
              available:true,state:'snapshot',imageUrl:'/data/ocean/' + id + '/image.png',legendUrl:'/data/ocean/' + id + '/legend.png'};
          }
          if (disposed) return;
          publish(id, {...meta,backend});
          await showOcean(id);
        } catch(error) {if (!disposed) publish(id, {error:String(error.message || error)});}
      }));
    } finally {pending = false; if (queuedPoll && !disposed) {queuedPoll = false; queueMicrotask(poll);}}
  }
  function sync(next, previous) {
    for (const id of oceanIds) if (!previous || next.layers[id] !== previous.layers[id]) showOcean(id);
    for (const id of referenceIds) if (!previous || next.layers[id] !== previous.layers[id]) references.setEnabled(id, !!next.layers[id]);
  }
  const unsubscribe = layersStore.subscribe(sync);
  const unsubscribeWeather = weatherStore.subscribe((next, previous) => {
    if (next.liveEnabled !== previous.liveEnabled || next.networkAvailable !== previous.networkAvailable) poll();
  });
  const wake = () => {if (activeNetwork(weatherStore)) poll();};
  const interval = setInterval(wake, 60000);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  sync(layersStore.getState()); poll();
  return () => {
    disposed = true; clearInterval(interval); unsubscribe(); unsubscribeWeather(); references.destroy();
    window.removeEventListener('atlas-reference-status', referenceEvent);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake); window.removeEventListener('focus', wake);
    if (!viewer.isDestroyed()) for (const {layer} of rendered.values()) viewer.imageryLayers.remove(layer, true);
    rendered.clear(); generations.clear();
  };
}

export function createServiceUI({React, jsx, jsxs, useTranslation, store, weatherStore, formatTime}) {
  const el = (tag, props, ...children) => jsxs(tag, {...props,children});
  function useStatus(id) {
    const [state, setState] = React.useState(serviceState);
    React.useEffect(() => {subscribers.add(setState); setState(serviceState); return () => subscribers.delete(setState);}, []);
    return state[id] || {};
  }
  function ServiceDetail({id}) {
    const {t} = useTranslation(), meta = useStatus(id), enabled = store(s => s.layers[id]);
    const online = weatherStore(s => s.liveEnabled && s.networkAvailable !== false);
    const current = store(s => s.field);
    if (id === 'currents') return el('div',{className:'atlas-service-detail','data-service':id,'data-simulated':String(current.simulated)},
      el('p',{className:'panel__hint'},current.simulated ? t('当前回退为模拟演示；真实数据暂不可用。','Simulated fallback; genuine current data unavailable.') :
        t('卫星派生地转分量；按日发布，存在延迟。有效时间：','Satellite-derived geostrophic component, published daily with delay. Valid: ') + (current.currentMetadata?.validTime || '—'),
        jsx('br',{}),t('不含潮汐或全部风生流；缺测及极区不显示流线。每 6 小时检查新产品。','Excludes tides and total wind-driven flow. Gaps and polar areas have no streamlines. Updates checked every 6 hours.'),
        current.currentStatus?.error ? t(' · 更新失败，保留已保存分析',' · Update failed; keeping saved analysis') : ''));
    if (oceanIds.includes(id)) return el('div', {className:'atlas-service-detail','data-service':id,'data-render-status':meta.renderStatus || 'idle'},
      el('p', {className:'panel__hint',role:'status'},
        meta.available ? (online && meta.state === 'live' ? t('已连接 · ', 'Connected · ') : t('已保存 · ', 'Saved · ')) + (meta.validDate || '—') : t('正在读取产品…','Loading product…'),
        meta.refreshing ? t(' · 检查新影像中',' · Checking for new imagery') : '',
        jsx('br',{}), t(meta.aggregation || info[id].aggregation,meta.aggregationEn || info[id].aggregationEn),
        meta.error ? t(' · 更新失败，保留已有影像',' · Update failed; keeping saved imagery') : '',
        meta.renderError ? t(' · 图层加载失败，可重新开关重试',' · Layer failed to load; toggle to retry') : ''),
      enabled && meta.legendUrl ? el('figure',{className:'atlas-service-legend'},
        jsx('img',{src:meta.legendUrl,alt:t(titles[id]+' 官方色标','Official color scale') + ' (' + (meta.units || info[id].units) + ')'}),
        el('figcaption',{},(meta.credit || info[id].credit) + ' · ' + (meta.units || info[id].units))) : null);
    if (referenceIds.includes(id)) return el('div',{className:'atlas-service-detail','data-service':id,'data-render-status':meta.status || 'idle'},
      el('p',{className:'panel__hint'}, id === 'eez' ? t('Marine Regions v12 · 2023；含争议边界的资料图，非法律或航海依据。','Marine Regions v12 · 2023. Includes disputed boundaries; not for legal or navigation use.') : id === 'plates' ? t('PB2002 · 241 条板块边界；固定版本地学资料。','PB2002 · 241 plate boundaries; versioned reference data.') : t('PB2002 · 洋中脊（黄色）及俯冲带（粉色），不是完整海底地貌清单。','PB2002 · Spreading ridges (yellow) and subduction boundaries (pink); not a full bathymetric inventory.'),
        meta.status === 'error' ? t(' · 加载失败',' · Load failed') : ''),
      enabled && id === 'eez' ? jsx('img',{className:'atlas-eez-legend',src:'/data/services-reference/eez-v12-legend.png',alt:t('Marine Regions 官方边界类型图例','Marine Regions boundary categories')}) : null);
    if (id === 'landrelief') return el('p',{className:'panel__hint'},t('Mapzen 公开高程；缩放到山地后按需加载并缓存。缺失瓦片以椭球面显示。','Mapzen public elevations; zoom into mountains to load and cache. Missing tiles use the ellipsoid.'));
    if (id === 'monsoon') return el('p',{className:'panel__hint'},t('尚未获得与原图层匹配的季风诊断产品；可用「10 米风场」查看最新模式风。','No matching monsoon diagnostic product is connected. Use 10 m winds for current model winds.'));
    if (id === 'airglow') return el('p',{className:'panel__hint'},t('尚无可接入的全球实时气辉产品。气辉与极光不同，未用极光或特效替代。','No global real-time airglow product is connected. Airglow differs from aurora.'));
    return null;
  }
  function ServicesOverview() {
    const {t} = useTranslation();
    return el('p',{className:'panel__hint atlas-services-overview'},t('海温、盐度和叶绿素自动检查新产品，每 6 小时更新；与上方联网开关同步。板块、俯冲带和海域边界使用已保存的正式版本资料。','Ocean products check for updates every 6 hours, following the online switch above. Tectonic and maritime boundaries use saved published reference versions.'));
  }
  function CurrentControls() {
    const {t} = useTranslation(), field = store(s=>s.field), time = store(s=>s.time);
    const open = store(s=>s.overlay === 'time');
    return el('div',{className:'timeline'+(open?' is-expanded':'')},
      el('button',{className:'timeline-toggle','aria-expanded':open,onClick:()=>store.getState().setOverlay(open?null:'time')},
        t('地转洋流 · 有效时间 ','Geostrophic analysis · Valid '),
        el('time',{},formatTime(field.timestamp)),el('span',{},open?'−':'+')),
      el('div',{className:'timeline-content'},
        el('p',{className:'panel__hint'},t('单期卫星派生分析。流线动画表示方向，播放不会改变数据日期或预测未来。','One satellite-derived analysis. Streamlines show direction; animation does not change the valid date or predict the future.')),
        el('div',{className:'tagrow'},el('button',{className:'tag',onClick:()=>store.getState().setPlaying(!time.playing)},time.playing?t('暂停动画','Pause animation'):t('播放动画','Play animation')))));
  }
  return {ServiceDetail,ServicesOverview,CurrentControls};
}
