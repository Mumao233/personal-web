import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  ArrowsOut,
  Compass,
  Minus,
  Plus,
  X,
} from "@phosphor-icons/react";
import { useTheme } from "./theme.jsx";

export const destinations = [
  {
    key: "about",
    label: "关于我",
    note: "一些正在发生的事",
    angle: 2.8,
    radius: 3.6,
    height: 1.55,
  },
  {
    key: "projects",
    label: "作品与项目",
    note: "做过的事与新的尝试",
    angle: 0.5,
    radius: 3.8,
    height: 1.8,
  },
  {
    key: "notes",
    label: "随笔",
    note: "还没有答案的问题",
    angle: 4.0,
    radius: 4.7,
    height: 0.35,
  },
  {
    key: "world",
    label: "关于世界",
    note: "地点、照片与当时的光",
    angle: 5.7,
    radius: 4.6,
    height: -0.2,
  },
  {
    key: "you",
    label: "关于你",
    note: "这次，想听听你",
    angle: 3.6,
    radius: 3.3,
    height: -1.7,
  },
  {
    key: "us",
    label: "关于我们",
    note: "留下一句话",
    angle: 0.3,
    radius: 3.2,
    height: -1.65,
  },
];

function Scene({ exploring, home, reduced, anchors, command, onState }) {
  const theme = useTheme();
  const mount = useRef(null);
  const state = useRef({ exploring, reduced, home, theme });
  state.current = { exploring, reduced, home, theme };
  useEffect(() => {
    let disposed = false,
      renderer,
      controls,
      observer,
      frame,
      scene,
      onContextLost;
    const geometries = new Set(),
      materials = new Set();
    const own = (item) => {
      (item.isMaterial ? materials : geometries).add(item);
      return item;
    };
    onState("loading");
    (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } =
          await import("three/addons/controls/OrbitControls.js");
        if (disposed || !mount.current) return;
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: "low-power",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
        renderer.setClearColor(0x050505, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.setAttribute("aria-hidden", "true");
        mount.current.appendChild(renderer.domElement);
        onContextLost = (event) => {
          event.preventDefault();
          cancelAnimationFrame(frame);
          onState("unavailable");
        };
        renderer.domElement.addEventListener("webglcontextlost", onContextLost);
        scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(
          state.current.theme === "light" ? 0xf6f2e9 : 0x050505,
          0.015,
        );
        let sceneTheme = state.current.theme,
          themeStarted = 0;
        const themeFrom = scene.fog.color.clone();
        const themeTo = scene.fog.color.clone();
        const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
        camera.position.set(0, 2.5, 13.5);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.075;
        controls.enablePan = false;
        controls.minDistance = 8;
        controls.maxDistance = 42;
        controls.minPolarAngle = 0.15;
        controls.maxPolarAngle = Math.PI - 0.15;
        controls.rotateSpeed = 0.5;
        controls.zoomSpeed = 0.7;
        controls.enabled = state.current.exploring;
        const system = new THREE.Group();
        system.rotation.z = -0.18;
        scene.add(system);
        const ambient = new THREE.HemisphereLight(0xcfb38a, 0x0b1722, 2.4);
        scene.add(ambient);
        const key = new THREE.DirectionalLight(0xffd7a2, 4.0);
        key.position.set(-3, 4, 5);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x7cacc1, 2.5);
        rim.position.set(5, 0, -3);
        scene.add(rim);
        const globe = new THREE.Mesh(
          own(new THREE.SphereGeometry(1.85, 64, 48)),
          own(
            new THREE.MeshStandardMaterial({
              color: state.current.theme === "light" ? 0x704b2c : 0x493222,
              roughness: 0.57,
              metalness: 0.5,
            }),
          ),
        );
        system.add(globe);
        const globeFrom = globe.material.color.clone();
        const globeTo = globe.material.color.clone();
        const grid = new THREE.LineSegments(
          own(
            new THREE.WireframeGeometry(
              own(new THREE.SphereGeometry(1.862, 32, 16)),
            ),
          ),
          own(
            new THREE.LineBasicMaterial({
              color: 0xa58360,
              transparent: true,
              opacity: 0.06,
            }),
          ),
        );
        globe.add(grid);
        function ring(radius, tilt, opacity, color = 0xa67c4d) {
          const points = Array.from({ length: 240 }, (_, i) => {
            const a = (i / 240) * Math.PI * 2;
            return new THREE.Vector3(
              Math.cos(a) * radius,
              Math.sin(a) * radius * 0.1,
              Math.sin(a) * radius,
            );
          });
          const line = new THREE.LineLoop(
            own(new THREE.BufferGeometry().setFromPoints(points)),
            own(
              new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity,
              }),
            ),
          );
          line.rotation.x = tilt;
          system.add(line);
          return line;
        }
        ring(2.3, 0.2, 0.7);
        ring(3.0, -0.24, 0.34);
        ring(3.4, 0.1, 0.28);
        ring(3.8, 0.15, 0.18);
        ring(4.1, 0.15, 0.1);
        ring(2.05, 1.28, 0.3, 0x7297a8);
        const nodes = destinations.map((d, index) => {
          const group = new THREE.Group();
          group.position.set(
            Math.cos(d.angle) * d.radius,
            d.height,
            Math.sin(d.angle) * d.radius * 0.42,
          );
          const mesh = new THREE.Mesh(
            own(new THREE.SphereGeometry(index === 3 ? 0.15 : 0.105, 20, 16)),
            own(
              new THREE.MeshStandardMaterial({
                color: index === 3 ? 0x90b3c3 : 0xd0a070,
                emissive: index === 3 ? 0x344e5b : 0x5d3b1e,
                emissiveIntensity: 0.6,
                roughness: 0.55,
              }),
            ),
          );
          group.add(mesh);
          system.add(group);
          return group;
        });
        // Deterministic stars keep the scene stable across remounts and devices.
        const positions = new Float32Array(240 * 3);
        let seed = 71;
        const random = () => {
          seed = (seed * 16807) % 2147483647;
          return (seed - 1) / 2147483646;
        };
        for (let i = 0; i < positions.length; i += 3) {
          positions[i] = (random() - 0.5) * 55;
          positions[i + 1] = (random() - 0.5) * 32;
          positions[i + 2] = -8 - random() * 20;
        }
        const starsGeometry = own(new THREE.BufferGeometry());
        starsGeometry.setAttribute(
          "position",
          new THREE.BufferAttribute(positions, 3),
        );
        scene.add(
          new THREE.Points(
            starsGeometry,
            own(
              new THREE.PointsMaterial({
                color: 0xc2c0b7,
                size: 0.03,
                transparent: true,
                opacity: 0.65,
                sizeAttenuation: true,
              }),
            ),
          ),
        );
        const resize = () => {
          if (!mount.current) return;
          const width = mount.current.clientWidth,
            height = mount.current.clientHeight;
          renderer.setSize(width, height, false);
          camera.aspect = width / Math.max(height, 1);
          camera.updateProjectionMatrix();
        };
        observer = new ResizeObserver(resize);
        observer.observe(mount.current);
        resize();
        const targetPosition = new THREE.Vector3(),
          targetLook = new THREE.Vector3(),
          projected = new THREE.Vector3();
        let previousMode = false,
          lastTime = 0,
          returning = false;
        command.current = (action) => {
          if (action === "reset") {
            const narrow = window.innerWidth < 760;
            camera.position.set(0, narrow ? 5.5 : 4.4, narrow ? 30 : 16);
            controls.target.set(0, 0, 0);
          } else {
            const factor = action === "in" ? 0.83 : 1.2;
            const offset = camera.position.clone().sub(controls.target);
            offset.setLength(
              THREE.MathUtils.clamp(
                offset.length() * factor,
                controls.minDistance,
                controls.maxDistance,
              ),
            );
            camera.position.copy(controls.target).add(offset);
          }
          controls.update();
        };
        function tick(time) {
          if (disposed) return;
          frame = requestAnimationFrame(tick);
          if (document.hidden || time - lastTime < 32) return;
          const delta = Math.min((time - lastTime) / 1000, 0.08);
          lastTime = time;
          const { exploring: free, reduced: quiet } = state.current;
          if (sceneTheme !== state.current.theme) {
            sceneTheme = state.current.theme;
            themeStarted = time;
            themeFrom.copy(scene.fog.color);
            themeTo.set(sceneTheme === "light" ? 0xf6f2e9 : 0x050505);
            globeFrom.copy(globe.material.color);
            globeTo.set(sceneTheme === "light" ? 0x704b2c : 0x493222);
          }
          scene.fog.color.lerpColors(
            themeFrom,
            themeTo,
            Math.min(1, (time - themeStarted) / (quiet ? 80 : 250)),
          );
          globe.material.color.lerpColors(
            globeFrom,
            globeTo,
            Math.min(1, (time - themeStarted) / (quiet ? 80 : 250)),
          );
          const width = mount.current.clientWidth,
            narrow = window.innerWidth < 760;
          if (free !== previousMode) {
            controls.enabled = free;
            if (free) {
              camera.position.set(0, narrow ? 5.5 : 4, narrow ? 30 : 16);
              controls.target.set(0, 0, 0);
            } else returning = true;
            previousMode = free;
          }
          const blend = quiet ? 1 : 1 - Math.exp(-delta * 4.5);
          if (!free) {
            // The reading canvas shares the actual hero scene box, rather than
            // guessing where text will land in a viewport-sized background.
            const distance = Math.max(
              7.5,
              8.7 / (2 * Math.tan(Math.PI / 9) * camera.aspect),
            );
            targetPosition.set(0, 2.4, distance);
            targetLook.set(0, 0, 0);
            camera.position.lerp(targetPosition, blend);
            controls.target.lerp(targetLook, blend);
            camera.lookAt(controls.target);
            if (returning && camera.position.distanceTo(targetPosition) < 0.02)
              returning = false;
          }
          system.position.lerp(targetPosition.set(0, 0, 0), blend);
          if (!quiet && !free) {
            globe.rotation.y += delta * 0.035;
            system.rotation.y += delta * 0.007;
          }
          controls.update();
          if (free) {
            scene.updateMatrixWorld();
            const labels = [];
            nodes.forEach((node, index) => {
              const anchor = anchors.current[index];
              if (!anchor) return;
              node.getWorldPosition(projected);
              projected.project(camera);
              const visible =
                projected.z < 1 &&
                Math.abs(projected.x) < 1.07 &&
                Math.abs(projected.y) < 0.82;
              anchor.style.visibility = visible ? "visible" : "hidden";
              const halfWidth = anchor.offsetWidth / 2 + 12;
              const labelX = THREE.MathUtils.clamp(
                (projected.x * 0.5 + 0.5) * width,
                halfWidth,
                width - halfWidth,
              );
              if (visible)
                labels.push({
                  anchor,
                  x: labelX,
                  y:
                    (-projected.y * 0.5 + 0.5) * mount.current.clientHeight +
                    12,
                  width: anchor.offsetWidth,
                  height: anchor.offsetHeight,
                });
            });
            const placed = [];
            labels
              .sort((a, b) => a.y - b.y)
              .forEach((label) => {
                label.y = Math.max(label.y, narrow ? 150 : 165);
                for (const previous of placed) {
                  if (
                    Math.abs(previous.x - label.x) <
                      (previous.width + label.width) / 2 + 8 &&
                    label.y < previous.y + previous.height + 8
                  )
                    label.y = previous.y + previous.height + 8;
                }
                if (
                  label.y + label.height >
                  mount.current.clientHeight - (narrow ? 195 : 170)
                )
                  label.anchor.style.visibility = "hidden";
                label.anchor.style.transform = `translate(${label.x}px, ${label.y}px) translateX(-50%)`;
                placed.push(label);
              });
          }
          renderer.render(scene, camera);
        }
        onState("ready");
        frame = requestAnimationFrame(tick);
      } catch (error) {
        if (!disposed) onState("unavailable");
      }
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      controls?.dispose();
      if (renderer) {
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          onContextLost,
        );
        renderer.dispose();
        renderer.domElement.remove();
      }
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      command.current = null;
    };
  }, []);
  return <div ref={mount} className="space-canvas" />;
}

export default function Space({
  home = false,
  sceneTarget,
  openRequest,
  showToggle = true,
  onOpen,
  onActiveChange,
  onRequestHandled,
}) {
  const [exploring, setExploring] = useState(false),
    [closing, setClosing] = useState(false);
  const [sceneState, setSceneState] = useState("loading");
  const [compactExplorer, setCompactExplorer] = useState(
    () => matchMedia("(max-height: 480px)").matches,
  );
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const anchors = useRef([]),
    command = useRef(null),
    dialog = useRef(null),
    toggle = useRef(null),
    savedScroll = useRef(0),
    exitTimer = useRef(null),
    focusFrame = useRef(null),
    closingRef = useRef(false),
    opener = useRef(null),
    latestRequest = useRef(null);
  const active = exploring || closing;
  const [readingBounds, setReadingBounds] = useState(null);
  useLayoutEffect(() => {
    const target = sceneTarget?.current;
    if (!home || !target) return;
    const measure = () => {
      const box = target.getBoundingClientRect();
      setReadingBounds({
        position: "absolute",
        inset: "auto",
        left: box.left + window.scrollX,
        top: box.top + window.scrollY,
        width: box.width,
        height: box.height,
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(target);
    if (target.parentElement) observer?.observe(target.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [home, sceneTarget, active]);
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);
  useEffect(() => {
    const media = matchMedia("(max-height: 480px)");
    const update = () => setCompactExplorer(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    mq.addEventListener("change", update);
    return () => {
      mq.removeEventListener("change", update);
      clearTimeout(exitTimer.current);
      cancelAnimationFrame(focusFrame.current);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const page = document.querySelector(".site-content");
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    if (page) page.inert = true;
    return () => {
      document.documentElement.style.overflow = previousOverflow;
      if (page) page.inert = false;
    };
  }, [active]);
  const open = (source) => {
    clearTimeout(exitTimer.current);
    exitTimer.current = null;
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
    closingRef.current = false;
    if (!active) savedScroll.current = window.scrollY;
    opener.current = source?.currentTarget || source || toggle.current;
    onOpen?.();
    setClosing(false);
    setExploring(true);
  };
  useLayoutEffect(() => {
    if (!exploring) return;
    dialog.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [exploring]);
  useEffect(() => {
    if (!openRequest || latestRequest.current === openRequest) return;
    latestRequest.current = openRequest;
    open(openRequest.opener);
    onRequestHandled?.(openRequest);
  }, [openRequest]);
  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTimeout(exitTimer.current);
    cancelAnimationFrame(focusFrame.current);
    setExploring(false);
    setClosing(true);
    // The reading document stays mounted, preserving forms and its exact scroll position.
    window.scrollTo({ top: savedScroll.current, behavior: "instant" });
    exitTimer.current = setTimeout(
      () => {
        exitTimer.current = null;
        setClosing(false);
        focusFrame.current = requestAnimationFrame(() => {
          if (!closingRef.current) return;
          closingRef.current = false;
          (opener.current?.isConnected
            ? opener.current
            : toggle.current || document.getElementById("main-content")
          )?.focus({ preventScroll: true });
          focusFrame.current = null;
        });
      },
      reduced ? 0 : 650,
    );
  };
  useEffect(() => {
    if (!active) return;
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closing) close();
      }
      if (event.key === "Tab") {
        const nodes = [
          ...dialog.current.querySelectorAll("a[href],button:not([disabled])"),
        ].filter((el) => getComputedStyle(el).visibility !== "hidden");
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (!dialog.current.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [active, closing, reduced]);
  return (
    <>
      {(home || active) && (
        <div
          className={`space-stage ${active ? "is-exploring" : "is-reading"} ${closing ? "is-returning" : ""} ${sceneState === "unavailable" ? "has-fallback" : ""}`}
          style={
            !active && sceneTarget
              ? {
                  ...readingBounds,
                  visibility: readingBounds ? "visible" : "hidden",
                }
              : undefined
          }
          data-scene-state={sceneState}
        >
          <Scene
            exploring={exploring}
            home={home}
            reduced={reduced}
            anchors={anchors}
            command={command}
            onState={setSceneState}
          />
          {sceneState !== "ready" && (
            <div className="space-fallback" aria-hidden="true">
              <span />
              <span />
              <span />
              <i />
            </div>
          )}
          {active && (
            <div
              className="space-explorer"
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby="space-title"
            >
              <div className="space-explorer-head">
                <div>
                  <span className="eyebrow">A SMALL PERSONAL UNIVERSE</span>
                  <h2 id="space-title">换个角度，认识我。</h2>
                  <p>
                    {sceneState !== "ready"
                      ? "3D 暂时不可用，也可以从这些入口继续。"
                      : compactExplorer
                        ? "拖动旋转 · 滚轮或双指缩放 · 从下方栏目继续"
                        : "拖动旋转 · 滚轮或双指缩放 · 点击一处光点"}
                  </p>
                </div>
                <button
                  onClick={close}
                  className="space-close"
                  disabled={closing}
                >
                  <ArrowLeft /> 返回阅读 <X />
                </button>
              </div>
              {sceneState === "ready" && !compactExplorer && (
                <div className="space-anchors">
                  {destinations.map((d, i) => (
                    <a
                      key={d.key}
                      href={`/?page=${d.key}`}
                      ref={(el) => {
                        anchors.current[i] = el;
                      }}
                      className="space-anchor"
                    >
                      <span>{d.label}</span>
                      <small>{d.note}</small>
                    </a>
                  ))}
                </div>
              )}
              <div className="space-explorer-bottom">
                <nav aria-label="探索栏目">
                  {destinations.map((d, i) => (
                    <a key={d.key} href={`/?page=${d.key}`}>
                      <span>0{i + 1}</span>
                      {d.label}
                      <ArrowUpRight />
                    </a>
                  ))}
                </nav>
                <div className="space-tools">
                  <a href="/solar/">
                    太阳系作品 <ArrowUpRight />
                  </a>
                  <button
                    disabled={sceneState !== "ready"}
                    aria-label="放大探索场景"
                    onClick={() => command.current?.("in")}
                  >
                    <Plus />
                  </button>
                  <button
                    disabled={sceneState !== "ready"}
                    aria-label="缩小探索场景"
                    onClick={() => command.current?.("out")}
                  >
                    <Minus />
                  </button>
                  <button
                    disabled={sceneState !== "ready"}
                    aria-label="重置探索视角"
                    onClick={() => command.current?.("reset")}
                  >
                    <ArrowsOut />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {!active && showToggle && (
        <button
          ref={toggle}
          className="space-toggle"
          onClick={open}
          aria-haspopup="dialog"
        >
          <Compass size={19} />
          <span>自由探索</span>
          <span className="space-toggle-mark">3D</span>
        </button>
      )}
    </>
  );
}
