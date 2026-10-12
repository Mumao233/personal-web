/**
 * Selected-location model forecasts from Open-Meteo's public APIs.
 * Values are model estimates, never in-situ observations. The global map layers
 * have their own sources and are not derived from these individual requests.
 */
const CACHE_KEY = "atlas-point-forecast-v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 24;
const REQUEST_TIMEOUT_MS = 12000;

const PROVIDERS = {
  weather: {
    endpoint: "https://api.open-meteo.com/v1/forecast",
    name: "Open-Meteo weather models",
    variables: "wind_speed_10m,wind_direction_10m,precipitation",
  },
  marine: {
    endpoint: "https://marine-api.open-meteo.com/v1/marine",
    name: "Open-Meteo / Copernicus / Météo-France SMOC",
    variables: "ocean_current_velocity,ocean_current_direction",
  },
};

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Forecast request was cancelled", "AbortError");
}

function checkAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function finite(value, minimum = -Infinity, maximum = Infinity) {
  return typeof value === "number" && Number.isFinite(value)
    && value >= minimum && value <= maximum ? value : null;
}

function velocity(value, unit) {
  if (value == null) return null;
  const n = finite(value, 0);
  if (n === null) throw new Error("Invalid velocity in forecast response");
  // Check actual returned units even though both APIs are requested in m/s.
  if (unit === "m/s") return n;
  if (unit === "km/h") return n / 3.6;
  if (unit === "mph") return n * 0.44704;
  if (unit === "kn" || unit === "knots") return n * 0.5144444444444445;
  throw new Error(`Unsupported velocity unit: ${String(unit)}`);
}

function direction(value, unit) {
  if (value == null) return null;
  if (unit !== "°") throw new Error("Unsupported direction unit");
  const n = finite(value, 0, 360);
  if (n === null) throw new Error("Invalid direction in forecast response");
  return n;
}

function parseResponse(kind, body, requestUrl, requestedCoordinates) {
  const current = body?.current;
  const units = body?.current_units;
  if (!current || !units || units.time !== "unixtime"
      || finite(current.time, 0, 253402300799) === null) {
    throw new Error("Forecast response has no valid UTC model time");
  }
  const time = new Date(current.time * 1000).toISOString();
  const intervalSeconds = finite(current.interval, 1, 86400);
  if (intervalSeconds === null) throw new Error("Forecast interval is missing");
  let values;
  if (kind === "weather") {
    if (units.precipitation !== "mm") throw new Error("Unsupported precipitation unit");
    const rain = current.precipitation == null ? null : finite(current.precipitation, 0);
    if (current.precipitation != null && rain === null) throw new Error("Invalid precipitation");
    values = {
      wind: velocity(current.wind_speed_10m, units.wind_speed_10m),
      direction: direction(current.wind_direction_10m, units.wind_direction_10m),
      rain,
    };
  } else {
    values = {
      current: velocity(current.ocean_current_velocity, units.ocean_current_velocity),
      currentDirection: direction(current.ocean_current_direction, units.ocean_current_direction),
    };
  }
  return {
    values,
    meta: {
      status: "online",
      dataStatus: Object.values(values).some(Number.isFinite) ? "available" : "no-data",
      provider: PROVIDERS[kind].name,
      requestUrl,
      requestedCoordinates,
      resolvedCoordinates: {lon: finite(body.longitude, -180, 180), lat: finite(body.latitude, -90, 90)},
      fetchedAt: new Date().toISOString(),
      validTime: time,
      intervalSeconds,
      modelTimeAgeSeconds: Math.max(0, Math.floor(Date.now() / 1000 - current.time)),
    },
  };
}

function readCache() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || "null");
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object"
        && !Array.isArray(parsed.entries)) return parsed.entries;
  } catch { /* Disabled or full localStorage must not prevent live requests. */ }
  return {};
}

function validCachedPart(kind, part) {
  if (!part || !part.values || !part.meta) return false;
  const keys = kind === "weather" ? ["wind", "direction", "rain"] : ["current", "currentDirection"];
  return keys.every(key => part.values[key] === null || Number.isFinite(part.values[key]))
    && Number.isFinite(Date.parse(part.meta.fetchedAt))
    && Number.isFinite(Date.parse(part.meta.validTime))
    && typeof part.meta.provider === "string"
    && finite(part.meta.intervalSeconds, 1, 86400) !== null;
}

function writeCache(key, parts) {
  try {
    // Re-read immediately before writing so separate coordinate requests do not
    // erase another request's results while they finish concurrently.
    const entries = readCache();
    entries[key] = {updatedAt: Date.now(), ...parts};
    const newest = Object.entries(entries).sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({
      version: 1, entries: Object.fromEntries(newest.slice(0, CACHE_LIMIT)),
    }));
  } catch { /* Forecasts also work when browser storage is unavailable. */ }
}

function fromCache(part, reason, error) {
  const cacheAgeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(part.meta.fetchedAt)) / 1000));
  const {error: previousError, ...provenance} = part.meta;
  return {
    values: {...part.values},
    meta: {...provenance, status: "cached", cacheReason: reason,
      cacheAgeSeconds, modelTimeAgeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(part.meta.validTime)) / 1000)),
      ...(error ? {error} : {})},
  };
}

async function loadSource(kind, lon, lat, signal, cached, force, offline) {
  checkAborted(signal);
  const usableCache = validCachedPart(kind, cached) ? cached : null;
  if (offline) return usableCache ? fromCache(usableCache, "offline") : {
    values: {}, meta: {
      status: "unavailable", dataStatus: "unavailable", provider: PROVIDERS[kind].name,
      requestedCoordinates: {lon, lat}, fetchedAt: null, validTime: null,
      intervalSeconds: null, error: "Offline mode: no saved forecast for this location",
    },
  };
  const cacheAge = usableCache ? Date.now() - Date.parse(usableCache.meta.fetchedAt) : Infinity;
  if (!force && cacheAge >= 0 && cacheAge < CACHE_TTL_MS) return fromCache(usableCache, "recent");

  const url = new URL(PROVIDERS[kind].endpoint);
  url.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), current: PROVIDERS[kind].variables,
    wind_speed_unit: "ms", timeformat: "unixtime", cell_selection: "nearest", timezone: "GMT",
  }).toString();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, {once: true});
  const timeout = setTimeout(() => controller.abort(new DOMException("Forecast source timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {signal: controller.signal, credentials: "omit", cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    checkAborted(signal);
    if (body?.error) throw new Error(String(body.reason || "Forecast provider error"));
    return parseResponse(kind, body, url.href, {lon, lat});
  } catch (error) {
    checkAborted(signal);
    const message = error instanceof Error ? error.message : String(error);
    if (usableCache) return fromCache(usableCache, "network-failure", message);
    return {values: {}, meta: {
      status: "unavailable", dataStatus: "unavailable", provider: PROVIDERS[kind].name,
      requestUrl: url.href, requestedCoordinates: {lon, lat}, fetchedAt: null, validTime: null,
      intervalSeconds: null, error: message,
    }};
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Return the original panel's scalar fields plus per-provider provenance.
 * Pass {force:true} for the explicit refresh action. Ordinary repeat queries
 * reuse a clearly labelled cache for five minutes. Failed providers fall back
 * independently to genuine previously fetched values at exactly this rounded
 * coordinate. No values are synthesized for failed or inland marine queries.
 */
export async function fetchPointForecast(lon, lat, signal, {force = false, offline = false} = {}) {
  if (finite(lon, -180, 180) === null || finite(lat, -90, 90) === null) {
    throw new RangeError("Forecast coordinates must be valid longitude and latitude");
  }
  checkAborted(signal);
  lon = Math.round(lon * 10000) / 10000;
  lat = Math.round(lat * 10000) / 10000;
  const key = `${lon.toFixed(4)},${lat.toFixed(4)}`;
  const cached = readCache()[key] || {};
  const [weather, marine] = await Promise.all([
    loadSource("weather", lon, lat, signal, cached.weather, force, offline),
    loadSource("marine", lon, lat, signal, cached.marine, force, offline),
  ]);
  checkAborted(signal);
  const available = [weather, marine].filter(part => part.meta.status !== "unavailable");
  if (!available.length) {
    const error = new Error(offline
      ? "Offline mode: no saved forecast exists for this location"
      : "Weather and marine providers are unavailable; no saved forecast exists for this location");
    error.name = "ForecastUnavailableError";
    error.sources = {weather: weather.meta, marine: marine.meta};
    throw error;
  }
  writeCache(key, {
    ...(weather.meta.status !== "unavailable" ? {weather} : {}),
    ...(marine.meta.status !== "unavailable" ? {marine} : {}),
  });
  return {
    wind: null, direction: null, rain: null, current: null, currentDirection: null,
    ...weather.values, ...marine.values,
    time: weather.meta.validTime,
    marineTime: marine.meta.validTime,
    rainIntervalSeconds: weather.meta.intervalSeconds,
    fetchedAt: available.map(part => part.meta.fetchedAt).sort().at(-1),
    sources: {weather: weather.meta, marine: marine.meta},
  };
}
