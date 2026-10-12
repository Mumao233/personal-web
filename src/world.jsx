import React, { useEffect, useRef, useState } from "react";
import {
  GlobeHemisphereEast,
  MapTrifold,
  Plus,
  Minus,
  X,
  ArrowUpRight,
} from "@phosphor-icons/react";
import { date } from "./api";
export function cluster(stories, far) {
  if (!far) return stories.map((s) => ({ ...s, items: [s], count: 1 }));
  const groups = [];
  for (const s of stories) {
    let g = groups.find(
      (g) =>
        (s.city && s.city === g.city) ||
        Math.hypot(
          Number(s.lat) - g.lat,
          (Number(s.lng) - g.lng) * Math.cos((Number(s.lat) * Math.PI) / 180),
        ) < 0.55,
    );
    if (!g) {
      g = {
        ...s,
        lat: Number(s.cityLat ?? s.lat),
        lng: Number(s.cityLng ?? s.lng),
        items: [],
        count: 0,
      };
      groups.push(g);
    }
    g.items.push(s);
    g.count++;
  }
  return groups;
}
export default function World({ stories = [], onPick, pick, compact = false }) {
  const mount = useRef(null),
    instance = useRef(null);
  const [flat, setFlat] = useState(false),
    [far, setFar] = useState(true),
    [countries, setCountries] = useState([]),
    [selected, setSelected] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const callback = useRef(onPick);
  callback.current = onPick;
  const markers = cluster(stories, far);
  const dataRef = useRef(markers);
  dataRef.current = markers;
  const borders = countries.flatMap((country) =>
    country.geometry.type === "Polygon"
      ? country.geometry.coordinates
      : country.geometry.coordinates.flat(),
  );
  const borderRef = useRef(borders);
  borderRef.current = borders;
  useEffect(() => {
    fetch("/assets/countries.json")
      .then((r) => r.json())
      .then((d) => setCountries(d.features))
      .catch(() => setError("地图轮廓暂时无法读取"));
  }, []);
  useEffect(() => {
    if (flat) return;
    let disposed = false,
      observer,
      disposeOutline;
    setLoading(true);
    (async () => {
      try {
        const [{ default: Globe }, THREE] = await Promise.all([
          import("globe.gl"),
          import("three"),
        ]);
        if (disposed || !mount.current) return;
        const g = new Globe(mount.current, { animateIn: false })
          .backgroundColor("#080a0b")
          .globeMaterial(new THREE.MeshBasicMaterial({ color: "#080a0b" }))
          .showAtmosphere(false)
          .pathsData(borderRef.current)
          .pathPoints((ring) => ring)
          .pathPointLat((point) => point[1])
          .pathPointLng((point) => point[0])
          .pathColor(() => "#8dabb8")
          .pathStroke(null)
          .pathTransitionDuration(0)
          .onPathClick((_, event, coords) => callback.current?.(coords))
          .pointOfView({ lat: 25, lng: 108, altitude: 2.4 }, 0)
          .htmlElement((d) => {
            const b = document.createElement("button");
            b.className = "globe-marker";
            b.textContent = d.count > 1 ? String(d.count) : "•";
            b.title =
              d.count > 1
                ? (d.city || "附近地点") + " · " + d.count + "个记录"
                : d.title;
            b.onclick = () => {
              if (d.count > 1) {
                g.pointOfView({ lat: d.lat, lng: d.lng, altitude: 0.35 }, 700);
                setFar(false);
              }
              setSelected(d);
            };
            return b;
          })
          .htmlLat("lat")
          .htmlLng("lng")
          .htmlAltitude(0.015)
          .htmlElementsData(dataRef.current)
          .onGlobeClick((coords) => callback.current?.(coords));
        instance.current = g;
        // A camera-facing circumference keeps the sphere legible without a texture.
        const outlineGeometry = new THREE.BufferGeometry().setFromPoints(
          Array.from({ length: 192 }, (_, i) => {
            const angle = (i / 192) * Math.PI * 2;
            const radius = g.getGlobeRadius() + 0.02;
            return new THREE.Vector3(
              Math.cos(angle) * radius,
              Math.sin(angle) * radius,
              0,
            );
          }),
        );
        const outlineMaterial = new THREE.LineBasicMaterial({
          color: "#6f919e",
        });
        const outline = new THREE.LineLoop(outlineGeometry, outlineMaterial);
        const syncOutline = () => {
          const camera = g.camera();
          const radius = g.getGlobeRadius();
          const distance = camera.position.length();
          // Perspective silhouette is a tangent circle, not the sphere's equator.
          outline.quaternion.copy(camera.quaternion);
          outline.position
            .copy(camera.position)
            .normalize()
            .multiplyScalar((radius * radius) / distance + 0.08);
          outline.scale.setScalar(
            Math.sqrt(Math.max(0, 1 - (radius / distance) ** 2)),
          );
        };
        syncOutline();
        g.scene().add(outline);
        disposeOutline = () => {
          g.scene().remove(outline);
          outlineGeometry.dispose();
          outlineMaterial.dispose();
        };
        g.controls().autoRotate = false;
        g.controls().enableZoom = true;
        g.controls().minDistance = 105;
        g.controls().maxDistance = 650;
        g.controls().addEventListener("change", () => {
          syncOutline();
          setFar(g.pointOfView().altitude > 0.9);
        });
        const resize = () => {
          if (mount.current)
            g.width(mount.current.clientWidth).height(
              compact
                ? 360
                : Math.min(
                    620,
                    Math.max(420, mount.current.clientWidth * 0.57),
                  ),
            );
        };
        observer = new ResizeObserver(resize);
        observer.observe(mount.current);
        resize();
        setLoading(false);
      } catch {
        if (!disposed) {
          setError("当前设备无法显示3D地球，请使用平面地图。");
          setFlat(true);
        }
      }
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      disposeOutline?.();
      if (instance.current) {
        instance.current._destructor();
        instance.current = null;
      }
    };
  }, [flat, compact]);
  useEffect(() => {
    instance.current?.pathsData(borders);
  }, [countries]);
  useEffect(() => {
    instance.current?.htmlElementsData(
      pick
        ? [...markers, { ...pick, title: "待确认位置", count: 1, items: [] }]
        : markers,
    );
  }, [stories, far, pick]);
  const rings = (geometry) =>
    geometry.type === "Polygon"
      ? geometry.coordinates
      : geometry.coordinates.flat();
  const path = (geometry) =>
    rings(geometry)
      .map(
        (r) =>
          "M" +
          r
            .map(
              ([lng, lat]) =>
                `${((lng + 180) * 1000) / 360},${((90 - lat) * 500) / 180}`,
            )
            .join("L") +
          "Z",
      )
      .join("");
  const select = (g) => {
    setSelected(g);
  };
  return (
    <div className={"world " + (compact ? "compact" : "")}>
      <div className="world-toolbar">
        <div className="segmented">
          <button
            className={!flat ? "selected" : ""}
            onClick={() => setFlat(false)}
          >
            <GlobeHemisphereEast /> 地球
          </button>
          <button
            className={flat ? "selected" : ""}
            onClick={() => setFlat(true)}
          >
            <MapTrifold /> 平面地图
          </button>
        </div>
        <span>
          {onPick
            ? "点击地图选择精确位置"
            : stories.length
              ? `${stories.length} 个记录 · ${new Set(stories.map((s) => s.city || s.location)).size} 个地方`
              : "世界很大，记录从这里开始。"}
        </span>
      </div>
      {flat ? (
        <div className="flat-map">
          <svg
            viewBox="0 0 1000 500"
            role="img"
            aria-label="世界地图"
            onClick={(e) => {
              if (!onPick) return;
              const box = e.currentTarget.getBoundingClientRect();
              onPick({
                lng: ((e.clientX - box.left) / box.width) * 360 - 180,
                lat: 90 - ((e.clientY - box.top) / box.height) * 180,
              });
            }}
          >
            {countries.map((f, i) => (
              <path key={i} d={path(f.geometry)} />
            ))}
            {cluster(stories, true).map((g, i) => (
              <g
                key={i}
                transform={`translate(${((Number(g.lng) + 180) * 1000) / 360},${((90 - Number(g.lat)) * 500) / 180})`}
                onClick={(e) => {
                  e.stopPropagation();
                  select(g);
                }}
                tabIndex="0"
                role="button"
                aria-label={g.title}
                onKeyDown={(e) => {
                  if (e.key === "Enter") select(g);
                }}
              >
                <circle r="5" />
                <text y="-12" textAnchor="middle">
                  {g.city || g.title}
                  {g.count > 1 ? " · " + g.count : ""}
                </text>
              </g>
            ))}
            {pick && (
              <circle
                className="pick"
                cx={((Number(pick.lng) + 180) * 1000) / 360}
                cy={((90 - Number(pick.lat)) * 500) / 180}
                r="6"
              />
            )}
          </svg>
        </div>
      ) : (
        <div className="globe-wrap">
          <div ref={mount} className="globe-canvas" />
          {loading && <div className="globe-loading">正在展开地球…</div>}
          <div className="globe-controls">
            <button
              aria-label="放大"
              onClick={() => {
                const g = instance.current;
                if (g)
                  g.pointOfView(
                    {
                      ...g.pointOfView(),
                      altitude: Math.max(0.1, g.pointOfView().altitude * 0.65),
                    },
                    400,
                  );
              }}
            >
              <Plus />
            </button>
            <button
              aria-label="缩小"
              onClick={() => {
                const g = instance.current;
                if (g)
                  g.pointOfView(
                    {
                      ...g.pointOfView(),
                      altitude: Math.min(5, g.pointOfView().altitude * 1.5),
                    },
                    400,
                  );
              }}
            >
              <Minus />
            </button>
          </div>
          <span className="globe-hint">
            拖动旋转 · 滚动缩放{onPick ? " · 点击定位" : ""}
          </span>
        </div>
      )}
      {error && <p className="fine">{error}</p>}
      {selected && (
        <div className="story-detail">
          <button
            className="close"
            aria-label="关闭故事"
            onClick={() => setSelected(null)}
          >
            <X />
          </button>
          {selected.items.map((s) => (
            <article key={s.id}>
              <span className="eyebrow">
                {s.location || s.city} / {date(s.date)}
              </span>
              <h2>{s.title}</h2>
              <p className="story-body">{s.body}</p>
              <div className="photo-grid">
                {(s.photos || []).map((photo, i) => (
                  <a href={photo} target="_blank" rel="noreferrer" key={i}>
                    <img
                      src={photo}
                      alt={s.title + " · " + (i + 1)}
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      {!compact && (
        <div className="world-stories">
          {stories.length ? (
            stories.map((s) => (
              <button
                className="story-row"
                key={s.id}
                onClick={() => {
                  setSelected({ ...s, items: [s] });
                  instance.current?.pointOfView(
                    { lat: Number(s.lat), lng: Number(s.lng), altitude: 0.5 },
                    700,
                  );
                }}
              >
                {s.photos?.[0] && <img src={s.photos[0]} alt="" />}
                <div>
                  <span className="eyebrow">
                    {s.location} / {date(s.date)}
                  </span>
                  <h3>{s.title}</h3>
                </div>
                <ArrowUpRight />
              </button>
            ))
          ) : (
            <div className="empty">
              <h3>还没有放下第一个锚点。</h3>
              <p>等照片选好，把真正去过的地方留在这里。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
