/** Versioned scientific reference layers. Sources and licenses are in the manifest. */
const BASE = '/data/services-reference/';
const TITLES = {plates: 'PB2002 plate boundaries', trenches: 'PB2002 ridges and subduction zones', eez: 'Marine Regions maritime boundaries v12 (2023)'};

export function attachReferenceLayers(Cesium, viewer) {
  const items = new Map();
  const pending = new Map();
  const wanted = new Map();
  const renderPumps = new Map();
  const state = {};
  let disposed = false;
  const render = () => { if (!disposed && !viewer.isDestroyed()) viewer.scene.requestRender(); };
  function stopPump(id) {
    const timer = renderPumps.get(id);
    if (timer) clearInterval(timer);
    renderPumps.delete(id);
  }
  function pumpVector(id) {
    stopPump(id);
    const deadline = Date.now() + 15000;
    let ticks = 0;
    // With requestRenderMode, adding a data source can finish before Cesium's
    // ground-polyline workers. Keep frames moving only while that work settles.
    const timer = setInterval(() => {
      if (disposed || viewer.isDestroyed() || !wanted.get(id) || Date.now() >= deadline) {
        stopPump(id); return;
      }
      render();
      ticks++;
      const collection = viewer.scene.groundPrimitives;
      let ready = collection.length > 0, observedReady = false;
      for (let i = 0; i < collection.length; i++) {
        const primitive = collection.get(i);
        if (primitive.ready === false) ready = false;
        if (primitive.ready === true) observedReady = true;
      }
      if (ticks >= 10 && ready && observedReady) stopPump(id);
    }, 100);
    renderPumps.set(id, timer);
    render();
  }
  function notify(id, values) {
    state[id] = {...state[id], ...values};
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('atlas-reference-status', {detail: {id, ...state[id]}}));
  }
  async function json(name) {
    const response = await fetch(BASE + name);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const data = await response.json();
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error(`${name}: invalid GeoJSON`);
    return data;
  }
  async function vector(id) {
    const data = await json(id === 'plates' ? 'pb2002-boundaries.geojson' : 'pb2002-ridges-subduction.geojson');
    const source = new Cesium.CustomDataSource(TITLES[id]);
    let count = 0;
    for (const feature of data.features) {
      const lines = feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [feature.geometry.coordinates];
      for (const line of lines) {
        if (!Array.isArray(line) || line.length < 2) continue;
        if (line.some(point => !Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[1]) > 90)) continue;
        const category = feature.properties?.class;
        const css = id === 'plates' ? '#75e9f3' : category === 'OSR' ? '#ffd074' : '#ff778b';
        const color = Cesium.Color.fromCssColorString(css);
        const name = feature.properties?.Name || feature.properties?.plate_pair || TITLES[id];
        source.entities.add({
          id: `reference:${id}:${count++}`,
          name: `${name}${category ? ' · ' + category : ''}`,
          description: 'PB2002 / Peter Bird (2003). Conversion: Hugo Ahlenius / Nordpil. ODC-By-1.0. ' +
            (id === 'trenches' ? 'OSR: oceanic spreading ridge; SUB: subduction boundary. These are tectonic reference lines, not a complete bathymetric inventory.' : 'Published tectonic plate reference geometry.'),
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(line.flatMap(point => [point[0], point[1]])),
            width: id === 'plates' ? 1.4 : 2.1,
            material: color,
            clampToGround: true,
            arcType: Cesium.ArcType.GEODESIC,
          },
        });
      }
    }
    if (disposed || viewer.isDestroyed()) return null;
    source.show = !!wanted.get(id);
    await viewer.dataSources.add(source);
    return {kind: 'vector', resource: source, features: count};
  }
  async function eez() {
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(BASE + 'eez-v12-global.png', {
      rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
      credit: new Cesium.Credit('<a href="https://www.marineregions.org/sources.php#marbound" target="_blank" rel="noopener noreferrer">Marine Regions / VLIZ · v12 (2023) · CC BY 4.0</a>'),
    });
    if (disposed || viewer.isDestroyed()) return null;
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.show = !!wanted.get('eez');
    // Preserve official categories and dash styles while keeping thin dark lines visible on ocean imagery.
    layer.brightness = 2.8;
    layer.gamma = 0.65;
    return {kind: 'imagery', resource: layer, features: null};
  }
  async function ensure(id) {
    if (items.has(id)) return items.get(id);
    if (pending.has(id)) return pending.get(id);
    notify(id, {status: 'loading', title: TITLES[id], enabled: !!wanted.get(id), mode: 'versioned-reference'});
    const promise = (id === 'eez' ? eez() : vector(id)).then(item => {
      if (item) items.set(id, item);
      pending.delete(id);
      return item;
    }).catch(error => {
      pending.delete(id);
      notify(id, {status: 'error', enabled: false, error: String(error.message || error)});
      return null;
    });
    pending.set(id, promise);
    return promise;
  }
  return {
    async setEnabled(id, enabled) {
      if (!Object.hasOwn(TITLES, id) || disposed) return false;
      wanted.set(id, !!enabled);
      const item = enabled ? await ensure(id) : items.get(id);
      if (!item || disposed || viewer.isDestroyed()) return false;
      item.resource.show = !!wanted.get(id);
      if (item.kind === 'vector' && item.resource.show) pumpVector(id);
      else stopPump(id);
      notify(id, {status: 'ready', enabled: item.resource.show, features: item.features, title: TITLES[id], mode: 'versioned-reference'});
      render();
      return true;
    },
    getStatus() { return structuredClone(state); },
    destroy() {
      disposed = true;
      wanted.clear();
      for (const id of renderPumps.keys()) stopPump(id);
      if (!viewer.isDestroyed()) {
        for (const item of items.values()) {
          if (item.kind === 'imagery') viewer.imageryLayers.remove(item.resource, true);
          else viewer.dataSources.remove(item.resource, true);
        }
      }
      items.clear();
    },
  };
}
