import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

let dom, vite, root, createRoot, Intro, TypeQuote, Space, App, sessionState;
let reduced = false;
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
  ]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  }
  globalThis.matchMedia = (query) => ({
    matches: query.includes("prefers-reduced-motion") ? reduced : false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.scrollTo = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ Intro, TypeQuote } = await vite.ssrLoadModule("/src/home-experience.jsx"));
  ({ default: Space } = await vite.ssrLoadModule("/src/space.jsx"));
  ({ default: App } = await vite.ssrLoadModule("/src/main.jsx"));
  ({ sessionState } = await vite.ssrLoadModule("/src/browser-state.js"));
});
async function unmount() {
  if (root) await act(() => root.unmount());
  root = null;
}
afterEach(async () => {
  await unmount();
  reduced = false;
  globalThis.fetch = originalFetch;
  sessionState.removeItem("greeted");
  localStorage.setItem("personal-space.quote-paused", "0");
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
async function click(node) {
  assert.ok(node);
  await act(async () => node.click());
}
const waitFrames = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
const data = {
  profile: {
    name: "合成预览",
    intro: "保留的简介",
    interests: [],
    timeline: [],
  },
  surveys: [],
  projects: [],
  posts: [],
  stories: [],
  messages: [],
};
const serve = () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => data });
};

test("pausing completes the sentence, survives timer cycles and persists to the next mount", async (t) => {
  localStorage.setItem("personal-space.quote-paused", "0");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await mount(React.createElement(TypeQuote));
  await act(async () => t.mock.timers.tick(1000));
  const sentence = document.querySelector(".quote-accessible").textContent;
  await click(document.querySelector("button.quote-control"));
  assert.equal(
    document.querySelector(".typed > [aria-hidden]").textContent,
    sentence + "|",
  );
  assert.equal(localStorage.getItem("personal-space.quote-paused"), "1");
  assert.equal(
    document.querySelector(".quote-control").getAttribute("aria-pressed"),
    "true",
  );
  await act(async () => t.mock.timers.tick(60000));
  assert.equal(
    document.querySelector(".quote-accessible").textContent,
    sentence,
  );
  await unmount();
  await mount(React.createElement(TypeQuote));
  assert.equal(
    document.querySelector(".quote-control").textContent,
    "继续换句",
  );
  assert.equal(
    document.querySelector(".typed > [aria-hidden]").textContent,
    document.querySelector(".quote-accessible").textContent + "|",
  );
  await click(document.querySelector("button.quote-control"));
  assert.equal(localStorage.getItem("personal-space.quote-paused"), "0");
});

test("reduced motion displays one complete sentence and never rotates it automatically", async (t) => {
  reduced = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await mount(React.createElement(TypeQuote));
  const sentence = document.querySelector(".quote-accessible").textContent;
  assert.equal(
    document.querySelector(".typed > [aria-hidden]").textContent,
    sentence + "|",
  );
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(
    document.querySelector(".quote-accessible").textContent,
    sentence,
  );
  assert.equal(document.querySelector("button.quote-control"), null);
});

test("the welcome is marked when it starts and cannot replay on refresh or a return home", async () => {
  sessionState.removeItem("greeted");
  await mount(React.createElement(Intro));
  assert.ok(document.querySelector('[aria-label="欢迎"]'));
  assert.equal(sessionState.getItem("greeted"), "1");
  await click(document.querySelector(".intro button"));
  assert.equal(document.querySelector(".intro"), null);
  await unmount();
  await mount(React.createElement(Intro));
  assert.equal(document.querySelector(".intro"), null);
});

test("a deep link never welcomes or consumes the first home visit; hero opens the one existing explorer", async () => {
  serve();
  window.history.replaceState(null, "", "/?page=projects");
  await mount(React.createElement(App));
  await waitFrames();
  assert.equal(document.querySelector(".intro"), null);
  assert.equal(sessionState.getItem("greeted"), null);
  await act(async () => {
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  await waitFrames();
  assert.ok(document.querySelector(".intro"));
  await click(document.querySelector(".intro button"));
  const hero = document.querySelector(".universe-hero");
  hero.getBoundingClientRect = () => ({ bottom: 700 });
  await act(async () => window.dispatchEvent(new window.Event("scroll")));
  assert.equal(document.querySelector(".space-toggle"), null);
  const opener = document.querySelector(".hero-explore-button");
  await click(opener);
  await waitFrames();
  assert.equal(document.querySelectorAll(".space-stage").length, 1);
  assert.equal(
    document.querySelectorAll('[aria-label="探索栏目"] a').length,
    6,
  );
  assert.equal(document.querySelector(".site-content").inert, true);
  assert.ok(document.querySelector('.solar-feature-art[href="/solar/"]'));
  assert.equal(
    document.querySelector(".intro-copy p").textContent,
    "保留的简介",
  );
});

test("explorer returns focus to the actual opener and holds its keyboard boundary through closing", async () => {
  let request = null;
  const source = document.createElement("button");
  source.textContent = "actual opener";
  document.body.prepend(source);
  const element = () =>
    React.createElement(Space, { openRequest: request, showToggle: false });
  await mount(element());
  source.focus();
  request = { opener: source };
  await act(async () => root.render(element()));
  await waitFrames();
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(document.activeElement, document.querySelector(".space-close"));
  await click(document.querySelector(".space-close"));
  const links = [
    ...document.querySelectorAll(
      ".space-explorer a[href], .space-explorer button:not([disabled])",
    ),
  ];
  links.at(-1).focus();
  await act(async () =>
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(document.activeElement, links[0]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, source);
  source.remove();
});

test("the non-modal phone drawer focuses controls, leaves the background scrollable and exits at its tab boundary", async () => {
  serve();
  window.history.replaceState(null, "", "/?page=projects");
  await mount(React.createElement(App));
  await waitFrames();
  const toggle = document.querySelector(".menu-toggle");
  await click(toggle);
  const menu = document.getElementById("mobile-navigation");
  assert.equal(document.activeElement, menu.querySelector("button"));
  assert.notEqual(document.querySelector(".site-content").inert, true);
  assert.notEqual(document.documentElement.style.overflow, "hidden");
  menu.querySelectorAll("a")[5].focus();
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

test("a consumed hero request cannot reopen exploration after a standalone survey completes on a new visit", async () => {
  const survey = {
    id: "explore-lifecycle",
    title: "隔离生命周期问卷",
    definitionVersion: "v1",
    questions: [
      {
        id: "choice",
        title: "选择",
        type: "single",
        options: ["甲", "乙"],
        required: true,
      },
    ],
  };
  globalThis.fetch = async (url) => ({
    ok: true,
    status: url.endsWith("/submit") ? 201 : 200,
    json: async () =>
      url.includes("/public")
        ? { ...data, surveys: [survey] }
        : url.endsWith("/submit")
          ? { message: "隔离答卷已保存", completion: "completed" }
          : survey,
  });
  await mount(React.createElement(App));
  await waitFrames();
  const skip = document.querySelector(".intro button");
  if (skip) await click(skip);
  await click(document.querySelector(".hero-explore-button"));
  await waitFrames();
  await click(document.querySelector(".space-close"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  await act(async () => {
    window.history.pushState(
      null,
      "",
      "/?page=you&survey=explore-lifecycle&standalone=1",
    );
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  await waitFrames();
  assert.equal(document.querySelector(".space-stage"), null);
  await click(document.querySelector('input[type="radio"]'));
  await act(async () =>
    document
      .querySelector("form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  await waitFrames();
  assert.match(
    document.querySelector(".success").textContent,
    /隔离答卷已保存/,
  );
  assert.equal(document.querySelector(".space-explorer"), null);
  assert.notEqual(document.querySelector(".site-content").inert, true);
  assert.notEqual(document.documentElement.style.overflow, "hidden");
  localStorage.removeItem("survey-explore-lifecycle");
});

test("repeated closes share one exit and a rapid reopen cancels every pending focus return", async () => {
  const source = document.createElement("button");
  document.body.prepend(source);
  let request = { opener: source },
    handled = 0;
  const element = () =>
    React.createElement(Space, {
      openRequest: request,
      showToggle: false,
      onRequestHandled: () => handled++,
    });
  await mount(element());
  await waitFrames();
  assert.equal(handled, 1);
  const close = document.querySelector(".space-close");
  await act(async () => {
    close.click();
    close.click();
  });
  assert.equal(close.disabled, true);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  request = { opener: source };
  await act(async () => root.render(element()));
  assert.equal(handled, 2);
  assert.equal(document.querySelector(".space-close").disabled, false);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  assert.ok(document.querySelector(".space-explorer"));
  assert.equal(document.activeElement, document.querySelector(".space-close"));
  assert.equal(document.documentElement.style.overflow, "hidden");
  await click(document.querySelector(".space-close"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  assert.equal(document.querySelector(".space-explorer"), null);
  assert.equal(document.activeElement, source);
  source.remove();
});
