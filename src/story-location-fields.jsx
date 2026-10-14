import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { latestRequest } from "./editor-state";
import { validCoordinates } from "./media-workbench-state";
import ModuleBoundary from "./module-boundary";
const World = lazy(() => import("./world"));

function Field({ label, value, onChange, type = "text", ...props }) {
  return (
    <label>
      {label}
      <input
        type={type}
        value={value ?? ""}
        onChange={(event) =>
          onChange(
            event.target.value === ""
              ? ""
              : type === "number"
                ? Number(event.target.value)
                : event.target.value,
          )
        }
        {...props}
      />
    </label>
  );
}
export default function StoryLocationFields({ value, onChange }) {
  const precision = value.locationPrecision || "exact";
  const [query, setQuery] = useState(""),
    [places, setPlaces] = useState([]),
    [candidate, setCandidate] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [mapOpen, setMapOpen] = useState(false),
    [target, setTarget] = useState(precision === "city" ? "city" : "exact");
  const requests = useRef(latestRequest()),
    latest = useRef(value),
    activeQuery = useRef(query);
  latest.current = value;
  activeQuery.current = query;
  useEffect(() => () => requests.current.invalidate(), []);
  useEffect(() => {
    requests.current.invalidate();
    setCandidate(null);
    setBusy(false);
  }, [value.lat, value.lng]);
  const change = (key, entry) =>
    onChange((previous) => ({
      ...previous,
      [key]: entry,
      ...([
        "lat",
        "lng",
        "cityLat",
        "cityLng",
        "locationPrecision",
        "publicLocation",
      ].includes(key)
        ? { confirmLocation: false }
        : {}),
    }));
  async function search() {
    if (query.trim().length < 2) {
      setError("请输入至少两个字符的地点名称。");
      return;
    }
    const request = requests.current.next(),
      text = query;
    setBusy(true);
    setError("");
    try {
      const result = await api("/geocode?q=" + encodeURIComponent(text));
      if (requests.current.isCurrent(request) && activeQuery.current === text)
        setPlaces(result);
    } catch (error) {
      if (requests.current.isCurrent(request)) setError(error.message);
    } finally {
      if (requests.current.isCurrent(request)) setBusy(false);
    }
  }
  async function reverse() {
    if (!validCoordinates(value.lat, value.lng)) return;
    const request = requests.current.next(),
      coords = `${value.lat},${value.lng}`;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/admin/reverse?lat=${encodeURIComponent(value.lat)}&lng=${encodeURIComponent(value.lng)}`,
      );
      if (
        requests.current.isCurrent(request) &&
        `${latest.current.lat},${latest.current.lng}` === coords
      )
        setCandidate(result);
    } catch (error) {
      if (requests.current.isCurrent(request)) setError(error.message);
    } finally {
      if (requests.current.isCurrent(request)) setBusy(false);
    }
  }
  function choosePlace(place) {
    if (!validCoordinates(place.lat, place.lon)) {
      setError("候选地点没有有效坐标，请手动填写。");
      return;
    }
    const lat = Number(place.lat),
      lng = Number(place.lon);
    const city =
      place.address?.city ||
      place.address?.town ||
      place.address?.county ||
      place.name ||
      "";
    onChange((previous) =>
      target === "city"
        ? {
            ...previous,
            city,
            cityLat: lat,
            cityLng: lng,
            publicLocation: city || previous.publicLocation,
            confirmLocation: false,
          }
        : {
            ...previous,
            lat,
            lng,
            location: place.display_name || place.name || "",
            confirmLocation: false,
          },
    );
    setPlaces([]);
  }
  const mapLat = target === "city" ? value.cityLat : value.lat,
    mapLng = target === "city" ? value.cityLng : value.lng;
  return (
    <section className="story-location-fields" aria-label="故事地点与公开范围">
      <h2>地点与公开范围</h2>
      <div className="location-precision">
        {[
          [
            "city",
            "只公开城市",
            "地图使用单独选定的城市代表点，原始GPS留在后台。",
          ],
          ["exact", "公开精确位置", "地图会公开具体坐标，请核对后确认。"],
          ["hidden", "不公开坐标", "故事仍可阅读，但不会出现在地球地图上。"],
        ].map(([mode, label, hint]) => (
          <label key={mode}>
            <input
              type="radio"
              name="story-location-precision"
              checked={precision === mode}
              onChange={() => {
                change("locationPrecision", mode);
                if (mode !== "hidden") setTarget(mode);
              }}
            />
            <span>
              {label}
              <small className="fine"> · {hint}</small>
            </span>
          </label>
        ))}
      </div>
      <Field
        label="公开地名（展示给访客，可手填）"
        value={
          value.publicLocation ??
          (value.locationPrecision === undefined ? value.location : "")
        }
        onChange={(entry) => change("publicLocation", entry)}
        placeholder={
          precision === "hidden" ? "可留空，也可只写城市或国家" : "例如：广州"
        }
      />
      <div className="field-grid">
        <Field
          label="原始地点备注（仅后台）"
          value={value.location}
          onChange={(entry) => change("location", entry)}
        />
        <Field
          label="附近城市名称"
          value={value.city}
          onChange={(entry) => change("city", entry)}
        />
      </div>
      <details open={precision === "exact"}>
        <summary>原始精确坐标（城市级或不公开时仅后台保留）</summary>
        <div className="field-grid">
          <Field
            label="精确纬度"
            type="number"
            step="any"
            min="-90"
            max="90"
            value={value.lat}
            onChange={(entry) => change("lat", entry)}
          />
          <Field
            label="精确经度"
            type="number"
            step="any"
            min="-180"
            max="180"
            value={value.lng}
            onChange={(entry) => change("lng", entry)}
          />
        </div>
      </details>
      {precision === "city" && (
        <>
          <div className="field-grid">
            <Field
              label="公开城市代表点纬度"
              type="number"
              step="any"
              min="-90"
              max="90"
              value={value.cityLat}
              onChange={(entry) => change("cityLat", entry)}
            />
            <Field
              label="公开城市代表点经度"
              type="number"
              step="any"
              min="-180"
              max="180"
              value={value.cityLng}
              onChange={(entry) => change("cityLng", entry)}
            />
          </div>
          <p className="fine">
            城市代表点须单独选择或手填。这里不会默认使用原始GPS，也不通过简单取整生成公开位置。
          </p>
        </>
      )}
      {precision !== "hidden" && (
        <label className="check">
          <input
            type="checkbox"
            checked={!!value.confirmLocation}
            onChange={(event) =>
              change("confirmLocation", event.target.checked)
            }
          />
          {precision === "city"
            ? "我已确认这个城市名称与代表位置可以公开"
            : "我已确认这个精确位置可以公开"}
        </label>
      )}
      <details>
        <summary>主动查询地点或在地图上选点</summary>
        <p className="location-external-notice">
          只有点击下面的查询按钮，OpenStreetMap Nominatim
          才会接收你填写的查询文字或所选坐标。导入照片、读取GPS和手填坐标不会触发查询；这些字段也可以完全手填。
        </p>
        <label>
          选择结果用于
          <select
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setPlaces([]);
            }}
          >
            <option value="city">公开城市代表点</option>
            <option value="exact">原始精确位置</option>
          </select>
        </label>
        <div className="place-search">
          <Field
            label="搜索地址或城市"
            value={query}
            onChange={(entry) => {
              requests.current.invalidate();
              setQuery(entry);
              setPlaces([]);
              setBusy(false);
            }}
          />
          <button type="button" disabled={busy} onClick={search}>
            向 Nominatim 查询此文字
          </button>
        </div>
        {places.map((place, index) => (
          <button
            className="place-result"
            type="button"
            key={place.place_id || index}
            onClick={() => choosePlace(place)}
          >
            {target === "city" ? "设为公开城市代表点" : "设为原始精确位置"}：
            {place.display_name}
          </button>
        ))}
        <button
          type="button"
          className="quiet"
          disabled={busy || !validCoordinates(value.lat, value.lng)}
          onClick={reverse}
        >
          向 Nominatim 发送精确坐标并查询附近城市
        </button>
        {validCoordinates(value.lat, value.lng) && (
          <p className="fine">
            将发送：{value.lat}, {value.lng}
          </p>
        )}
        {candidate && (
          <div className="location-candidate">
            <strong>城市候选：{candidate.city || "未识别名称"}</strong>
            <span>
              代表点：{candidate.cityLat}, {candidate.cityLng}
            </span>
            <button
              type="button"
              disabled={
                !candidate.city ||
                !validCoordinates(candidate.cityLat, candidate.cityLng)
              }
              onClick={() => {
                onChange((previous) => ({
                  ...previous,
                  city: candidate.city,
                  publicLocation: candidate.city,
                  cityLat: Number(candidate.cityLat),
                  cityLng: Number(candidate.cityLng),
                  confirmLocation: false,
                }));
                setCandidate(null);
              }}
            >
              明确采用这个公开城市与代表点
            </button>
          </div>
        )}
        <button
          type="button"
          className="quiet"
          onClick={() => setMapOpen(!mapOpen)}
        >
          {mapOpen ? "收起地图" : "打开地图选择代表点或精确位置"}
        </button>
        {mapOpen && (
          <ModuleBoundary label="地点地图">
            <Suspense fallback={<p>正在打开地图…</p>}>
              <World
                compact
                pick={
                  validCoordinates(mapLat, mapLng)
                    ? { lat: Number(mapLat), lng: Number(mapLng) }
                    : undefined
                }
                onPick={(coords) =>
                  onChange((previous) =>
                    target === "city"
                      ? {
                          ...previous,
                          cityLat: Number(coords.lat),
                          cityLng: Number(coords.lng),
                          confirmLocation: false,
                        }
                      : {
                          ...previous,
                          lat: Number(coords.lat),
                          lng: Number(coords.lng),
                          confirmLocation: false,
                        },
                  )
                }
              />
            </Suspense>
          </ModuleBoundary>
        )}
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
