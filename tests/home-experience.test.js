import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

let dom, vite, root, createRoot, App, Toast, Segmented, Hover, Transition;
let hoverCapable = false;
const descriptors = new Map();
const originalFetch = globalThis.fetch;
before(async () => {
  dom = new JSDOM("<div id='test'></div>", {
    url: "https://example.test/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "location",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
    "getComputedStyle",
    "localStorage",
    "sessionStorage",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "matchMedia",
    "ResizeObserver",
    "Image",
  ]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  }
  globalThis.matchMedia = (query) => ({
    matches: query.includes("hover: hover") ? hoverCapable : false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ default: App } = await vite.ssrLoadModule("/src/main.jsx"));
  Toast = await vite.ssrLoadModule("/src/toast.jsx");
  ({ default: Segmented } = await vite.ssrLoadModule(
    "/src/segmented-control.jsx",
  ));
  ({ default: Hover } = await vite.ssrLoadModule("/src/hover-preview.jsx"));
  Transition = await vite.ssrLoadModule("/src/view-transition.js");
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
  hoverCapable = false;
  globalThis.fetch = originalFetch;
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
after(async () => {
  await vite?.close();
  dom.window.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  globalThis.fetch = originalFetch;
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});
async function mount(element) {
  root = createRoot(document.getElementById("test"));
  await act(async () => root.render(element));
}
const reply = (value) => ({ ok: true, status: 200, json: async () => value });
const sample = (overrides = {}) => ({
  profile: {
    name: "合成预览",
    intro: "保留的简介",
    interests: [
      { status: "甲", title: "第一项", text: "" },
      { status: "乙", title: "第二项", text: "" },
      { status: "丙", title: "第三项", text: "" },
      { status: "丁", title: "第四项", text: "" },
    ],
    timeline: [],
    acceptQuestions: true,
  },
  surveys: [],
  projects: [],
  posts: [],
  stories: [],
  messages: [],
  ...overrides,
});
const serve = (value) => {
  globalThis.fetch = async () => reply(value);
};
const text = () => document.getElementById("test").textContent;
const titles = (selector) =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent);

test("the homepage keeps its hero on first paint and marks data sections busy", async () => {
  let release;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      release = () => resolve(reply(sample()));
    });
  await mount(React.createElement(App));
  const main = document.querySelector("main");
  assert.equal(main.getAttribute("aria-busy"), "true");
  assert.equal(document.querySelector("h1").textContent, "在技术与价值之间。");
  assert.ok(document.querySelector("#work .skeleton"));
  const photo = document.querySelector(".hero-photo img");
  assert.notEqual(photo.getAttribute("loading"), "lazy");
  assert.equal(photo.getAttribute("fetchpriority"), "high");
  assert.match(photo.getAttribute("alt"), /广州塔与珠江新城/);
  assert.equal(document.querySelectorAll(".hero-photo source").length, 2);
  await act(async () => release());
  assert.equal(main.hasAttribute("aria-busy"), false);
  assert.equal(document.querySelector("#work .skeleton"), null);
  assert.equal(
    document.querySelector(".hero-intro p").textContent,
    "保留的简介",
  );
});

test("the homepage has no 3D scene, explorer, greeting or admin link", async () => {
  serve(sample());
  await mount(React.createElement(App));
  for (const selector of [
    ".space-stage",
    ".space-toggle",
    ".hero-explore-button",
    ".intro",
    'a[href="/?page=admin"]',
  ])
    assert.equal(document.querySelector(selector), null, selector);
  const source = await readFile(
    new URL("../src/main.jsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /three|space\.jsx|"\.\/space"/);
});

test("work follows the design order without inventing projects", async () => {
  serve(
    sample({
      projects: [
        { id: "a", title: "项目甲", category: "研究", excerpt: "摘要" },
        { id: "b", title: "项目乙", category: "工具", cover: "/uploads/b.jpg" },
      ],
    }),
  );
  await mount(React.createElement(App));
  assert.deepEqual(titles(".work-feature-title"), [
    "项目甲",
    "太阳系 · 人类造物图谱",
  ]);
  assert.deepEqual(titles(".work-row-title"), ["九格 · 图片生成器", "项目乙"]);
  assert.ok(document.querySelector('.work-feature[href="/solar/"]'));
  assert.ok(document.querySelector('.work-row[href="/nine-grid/"]'));
  await act(async () => root.unmount());
  root = null;
  serve(sample());
  await mount(React.createElement(App));
  assert.deepEqual(titles(".work-feature-title"), [
    "太阳系 · 人类造物图谱",
    "九格 · 图片生成器",
  ]);
  assert.equal(document.querySelector(".work-row"), null);
});

test("photos hide when there are no stories and link to details when there are", async () => {
  serve(sample());
  await mount(React.createElement(App));
  assert.equal(document.getElementById("photos"), null);
  await act(async () => root.unmount());
  serve(
    sample({
      stories: [
        { id: "s 1", title: "黄昏", city: "广州", cover: "/uploads/s.jpg" },
        { id: "s2", title: "无图" },
      ],
    }),
  );
  root = null;
  await mount(React.createElement(App));
  const tiles = document.querySelectorAll(".photo-tile");
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].getAttribute("href"), "/?page=world&story=s%201");
});

test("now shows three interests and conversation lists only open surveys", async () => {
  serve(
    sample({
      surveys: [
        { id: "open", title: "开放问卷", questionCount: 12 },
        { id: "shut", title: "关闭问卷", closed: true, questionCount: 3 },
      ],
    }),
  );
  await mount(React.createElement(App));
  assert.deepEqual(titles(".now-status"), ["甲", "乙", "丙"]);
  assert.deepEqual(titles(".talk-row span:first-child"), ["开放问卷"]);
  assert.match(document.querySelector(".talk-row").textContent, /12 题/);
  assert.match(text(), /有 1 份问卷正在开放/);
  assert.equal(
    document.querySelector(".talk-letter").getAttribute("href"),
    "/?page=us",
  );
});

test("notes show the two newest essays", async () => {
  serve(
    sample({
      posts: [
        { id: "old", title: "最早", date: "2026-01-01", excerpt: "甲" },
        { id: "new", title: "最新", date: "2026-11-09", excerpt: "乙" },
        { id: "mid", title: "中间", date: "2026-06-01", excerpt: "丙" },
      ],
    }),
  );
  await mount(React.createElement(App));
  assert.deepEqual(titles(".notes .note-row-title"), ["最新", "中间"]);
  assert.equal(document.querySelector(".notes .meta").textContent, "2026.11.09");
});

test("about hides phone and birth date, even if a profile still exposes them", async () => {
  window.history.replaceState(null, "", "/?page=about");
  serve(
    sample({
      profile: {
        ...sample().profile,
        bio: "自述",
        phone: "13800000000",
        email: "a@example.test",
        fields: [
          { id: "p", key: "phone", label: "电话", value: "13800000000", visible: true },
          { id: "b", key: "", label: "出生日期", value: "2000-01-01", visible: true },
          { id: "e", key: "email", label: "邮箱", value: "a@example.test", visible: true },
        ],
        timeline: [{ date: "连续六年", title: "班级电教员", text: "具体起止年份待补充" }],
      },
    }),
  );
  await mount(React.createElement(App));
  assert.doesNotMatch(text(), /13800000000|2000-01-01|待补充/);
  assert.match(text(), /a@example\.test/);
  assert.match(text(), /班级电教员/);
});

test("empty sections say 筹备中 and unknown pages offer the way home", async () => {
  window.history.replaceState(null, "", "/?page=notes");
  serve(sample());
  await mount(React.createElement(App));
  assert.equal(document.querySelector("main .pending").textContent, "筹备中");
  await act(async () => root.unmount());
  root = null;
  window.history.replaceState(null, "", "/?page=nowhere");
  await mount(React.createElement(App));
  assert.ok(document.querySelector('.not-found a[href="/"]'));
});

test("the non-modal phone drawer focuses controls, leaves the background scrollable and exits at its tab boundary", async () => {
  serve(sample());
  window.history.replaceState(null, "", "/?page=projects");
  await mount(React.createElement(App));
  const toggle = document.querySelector(".menu-toggle");
  await act(async () => toggle.click());
  const menu = document.getElementById("mobile-navigation");
  assert.equal(document.activeElement, menu.querySelector("button"));
  assert.notEqual(document.querySelector(".site-content").inert, true);
  assert.notEqual(document.documentElement.style.overflow, "hidden");
  menu.querySelectorAll("a")[4].focus();
  await act(async () =>
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, toggle);
  assert.equal(menu.getAttribute("aria-hidden"), "true");
});

test("projects filter by category from a keyboard-operable segmented control", async () => {
  window.history.replaceState(null, "", "/?page=projects");
  serve(
    sample({
      projects: [
        { id: "a", title: "项目甲", category: "研究" },
        { id: "b", title: "项目乙", category: "研究" },
      ],
    }),
  );
  await mount(React.createElement(App));
  const group = document.querySelector('[aria-label="按分类筛选作品"]');
  const buttons = () => [...group.querySelectorAll("button")];
  assert.deepEqual(
    buttons().map((node) => node.textContent),
    ["全部", "研究", "交互作品", "工具"],
  );
  assert.equal(buttons()[0].getAttribute("aria-pressed"), "true");
  buttons()[0].focus();
  await act(async () =>
    buttons()[0].dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  assert.equal(buttons()[1].getAttribute("aria-pressed"), "true");
  assert.equal(document.activeElement, buttons()[1]);
  assert.deepEqual(titles(".work-row-title"), ["项目甲", "项目乙"]);
  await act(async () =>
    buttons()[1].dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  assert.equal(buttons()[0].getAttribute("aria-pressed"), "true");
});

test("segmented arrows wrap and only the active option is a tab stop", async () => {
  let value = "a";
  const options = [
    { value: "a", label: "甲" },
    { value: "b", label: "乙" },
  ];
  const element = () =>
    React.createElement(Segmented, {
      label: "组",
      options,
      value,
      onChange(next) {
        value = next;
        root.render(element());
      },
    });
  await mount(element());
  const buttons = () => [...document.querySelectorAll('[role="group"] button')];
  assert.deepEqual(
    buttons().map((node) => node.tabIndex),
    [0, -1],
  );
  await act(async () =>
    buttons()[0].dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  assert.equal(value, "b");
});

function ToastHarness({ onReady }) {
  onReady(Toast.useToast());
  return null;
}

test("notifications stack to three, keep errors, and use the matching live region", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let toast;
  await mount(
    React.createElement(
      Toast.ToastProvider,
      null,
      React.createElement(ToastHarness, {
        onReady(value) {
          toast = value;
        },
      }),
    ),
  );
  const polite = document.querySelector('[aria-live="polite"]');
  const assertive = document.querySelector('[aria-live="assertive"]');
  assert.ok(polite && assertive, "live regions exist before any message");
  await act(async () => {
    toast.error("失败一");
    toast.success("成功一");
    toast.success("成功二");
    toast.success("成功三");
  });
  assert.equal(document.querySelectorAll(".toast").length, 3);
  assert.match(assertive.textContent, /失败一/);
  assert.doesNotMatch(polite.textContent, /成功一/);
  assert.match(polite.textContent, /成功三/);
  await act(async () => t.mock.timers.tick(Toast.TOAST_SUCCESS_MS));
  await act(async () => t.mock.timers.tick(200));
  assert.equal(polite.children.length, 0);
  assert.equal(assertive.children.length, 1, "failures wait for a manual close");
  await act(async () => assertive.querySelector("button").click());
  await act(async () => t.mock.timers.tick(200));
  assert.equal(assertive.children.length, 0);
});

test("toast limits prefer dropping successes over failures", () => {
  const items = [
    { id: 1, kind: "error" },
    { id: 2, kind: "success" },
    { id: 3, kind: "error" },
    { id: 4, kind: "error" },
  ];
  assert.deepEqual(
    Toast.trimToasts(items).map((item) => item.id),
    [1, 3, 4],
  );
});

test("hover previews need a fine pointer, are never interactive and skip coverless rows", async () => {
  const list = () =>
    React.createElement(
      Hover,
      null,
      React.createElement("a", { "data-preview": "/uploads/a.jpg" }, "有图"),
      React.createElement("a", null, "无图"),
    );
  await mount(list());
  const over = async (node) =>
    act(async () =>
      node.dispatchEvent(new window.Event("pointerover", { bubbles: true })),
    );
  await over(document.querySelector("[data-preview]"));
  assert.equal(document.querySelector(".hover-preview"), null);
  await act(async () => root.unmount());
  hoverCapable = true;
  root = null;
  await mount(list());
  await over(document.querySelector("a:not([data-preview])"));
  assert.equal(document.querySelector(".hover-preview"), null);
  await over(document.querySelector("[data-preview]"));
  const preview = document.querySelector(".hover-preview");
  assert.equal(preview.getAttribute("aria-hidden"), "true");
  assert.equal(preview.getAttribute("alt"), "");
});

test("a shared element is named only on the clicked link and handed off once", () => {
  document.getElementById("test").innerHTML = `
    <a id="one" href="/x" data-vt-collection="posts" data-vt-id="1" data-vt-part="title" data-vt-title="甲" data-vt-cover=""><b data-vt-element></b></a>
    <a id="two" href="/y" data-vt-collection="posts" data-vt-id="2" data-vt-part="title" data-vt-title="乙" data-vt-cover=""><b data-vt-element></b></a>`;
  const click = (node, init = {}) => {
    const event = new window.MouseEvent("click", { bubbles: true, ...init });
    Object.defineProperty(event, "target", { value: node });
    Transition.handleSharedClick(event);
  };
  const one = document.getElementById("one");
  const two = document.getElementById("two");
  click(one, { metaKey: true });
  assert.equal(one.firstChild.style.viewTransitionName || "", "");
  click(one);
  click(two);
  assert.equal(one.firstChild.style.viewTransitionName || "", "");
  assert.equal(two.firstChild.style.viewTransitionName, "shared-title");
  const route = { collection: "posts", id: "2" };
  assert.equal(Transition.takeSharedHandoff(route).title, "乙");
  assert.equal(Transition.takeSharedHandoff(route), null);
  document.getElementById("test").innerHTML = "";
});

test("public styles follow the restrained system and honor reduced motion", async () => {
  const source = (
    await Promise.all(
      ["base", "home", "pages", "components"].map((name) =>
        readFile(new URL(`../src/public/${name}.css`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  assert.doesNotMatch(source, /backdrop-filter|box-shadow|text-shadow|radial-gradient/);
  assert.equal(
    (source.match(/linear-gradient\(/g) || []).length,
    (source.match(/mask-image:\s*linear-gradient\(/g) || []).length,
    "the photo mask is the only gradient",
  );
  for (const [, value] of source.matchAll(/border-radius:\s*([^;]+);/g))
    assert.ok(
      ["var(--radius-pill)", "50%", "0"].includes(value.trim()),
      `unexpected radius ${value}`,
    );
  assert.match(source, /@view-transition/);
  assert.match(source, /prefers-reduced-motion: no-preference/);
  assert.ok((source.match(/prefers-reduced-motion: reduce/g) || []).length >= 1);
  assert.doesNotMatch(
    await readFile(new URL("../index.html", import.meta.url), "utf8"),
    /googleapis/,
  );
});
