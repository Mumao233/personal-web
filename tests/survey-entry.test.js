import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fakeSurveyLocks, surveyRecords } from "./survey-test-helpers.js";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { resolvePageRoute, surveyVisitUrl } from "../shared/page-info.js";

let dom, vite, App, Survey, createRoot;
const roots = [];
const descriptors = new Map();
const originalFetch = globalThis.fetch;
before(async () => {
  dom = new JSDOM("<div id='test'></div><div id='other-tab'></div>", {
    url: "https://example.test/?page=you&survey=first&standalone=1",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "location",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "FormData",
    "MutationObserver",
    "getComputedStyle",
    "localStorage",
    "sessionStorage",
    "requestAnimationFrame",
  ]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  }
  globalThis.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: fakeSurveyLocks(),
  });
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    plugins: [
      {
        name: "no-webgl-in-jsdom",
        enforce: "pre",
        load(id) {
          if (id.replaceAll("\\", "/").endsWith("/src/space.jsx"))
            return 'import React from "react"; export default function Space() { return React.createElement("div", { "data-testid": "site-scene" }); }';
        },
      },
    ],
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ default: App } = await vite.ssrLoadModule("/src/main.jsx"));
  ({ default: Survey } = await vite.ssrLoadModule("/src/survey.jsx"));
});
afterEach(async () => {
  await act(() => roots.splice(0).forEach((root) => root.unmount()));
  globalThis.fetch = originalFetch;
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  dom.window.history.replaceState(null, "", surveyVisitUrl("first", true));
});
after(async () => {
  await vite?.close();
  dom.window.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  delete globalThis.matchMedia;
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const reply = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
const questionnaire = (id = "first") => ({
  id,
  title: `问卷 ${id}`,
  description: "必要的填写说明",
  updatedAt: "revision",
  definitionVersion: "definition",
  questions: [
    {
      id: "choice",
      title: "你的选择",
      type: "single",
      required: true,
      options: ["甲", "乙"],
    },
  ],
});
const publicData = {
  profile: { name: "测试站点" },
  surveys: [questionnaire("first"), questionnaire("second")],
  projects: [],
  posts: [],
  stories: [],
  messages: [],
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function serve(
  submit = () =>
    reply({ message: "服务端已保存", completion: "completed" }, 201),
  get = questionnaire,
) {
  globalThis.fetch = async (url, options = {}) => {
    if (url === "/api/public?view=summary") return reply(publicData);
    if (url.endsWith("/submit")) return submit(url, options);
    return reply(get(decodeURIComponent(url.split("/").at(-1))));
  };
}
async function mount(element = React.createElement(App), target = "test") {
  const container = document.getElementById(target);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { root, container };
}
function noSiteChrome(container = document.body) {
  assert.equal(
    container.querySelector(
      "header, nav, footer, .menu-toggle, .mobile-menu-layer, .intro, [data-testid='site-scene']",
    ),
    null,
  );
  assert.equal(
    container.querySelector(
      "a[href='/'], a[href='/?page=you'], a[href='/?page=admin']",
    ),
    null,
  );
  for (const link of container.querySelectorAll("a[href]"))
    assert.equal(link.getAttribute("href"), "#main-content");
}
async function choose(container) {
  await act(async () => container.querySelector("input[type=radio]").click());
}
async function submit(container) {
  await act(async () =>
    container
      .querySelector("form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
}
async function navigate(url, event = "popstate") {
  await act(async () => {
    dom.window.history.pushState(null, "", url);
    dom.window.dispatchEvent(
      event === "popstate"
        ? new dom.window.PopStateEvent(event)
        : new dom.window.PageTransitionEvent(event, { persisted: true }),
    );
  });
}

test("standalone mode belongs only to an explicit survey route and link construction preserves ids", () => {
  assert.equal(surveyVisitUrl("a & b"), "/?page=you&survey=a%20%26%20b");
  assert.equal(resolvePageRoute(surveyVisitUrl("a & b", true)).id, "a & b");
  assert.equal(
    resolvePageRoute(surveyVisitUrl("a & b", true)).standalone,
    true,
  );
  for (const url of [
    "/?survey=x",
    "/?survey=x&standalone=0",
    "/?survey=x&standalone=true",
    "/?standalone=1",
    "/?answer=private&survey=x&standalone=1",
  ])
    assert.ok(!resolvePageRoute(url).standalone);
});

test("the very first independent render and loading form contain no mounted site navigation", async () => {
  const summary = deferred(),
    form = deferred();
  globalThis.fetch = (url) =>
    url.includes("/public") ? summary.promise : form.promise;
  const { container } = await mount();
  noSiteChrome();
  assert.match(container.textContent, /正在打开问卷/);
  await act(async () => form.resolve(reply(questionnaire())));
  noSiteChrome();
  assert.ok(
    container.querySelector("form"),
    "the form must not wait for unrelated public data",
  );
  assert.ok(container.querySelector(".theme-toggle"));
  await act(async () => summary.resolve(reply({ error: "首页不可用" }, 500)));
  noSiteChrome();
  assert.match(container.textContent, /必要的填写说明/);
});

test("validation and repeated clicks cannot reveal navigation; one confirmed server receipt can", async () => {
  const response = deferred();
  let submissions = 0;
  serve(() => {
    submissions++;
    return response.promise;
  });
  const { container } = await mount();
  await submit(container);
  assert.equal(submissions, 0);
  noSiteChrome();
  await choose(container);
  await submit(container);
  await submit(container);
  assert.equal(submissions, 1);
  noSiteChrome();
  await act(async () =>
    response.resolve(
      reply({ message: "服务端已保存", completion: "completed" }, 201),
    ),
  );
  assert.ok(container.querySelector("nav"));
  assert.ok(document.querySelector(".mobile-menu-layer"));
  assert.match(container.querySelector(".success").textContent, /服务端已保存/);
  assert.equal(location.search, "?page=you&survey=first&standalone=1");
  assert.equal(container.querySelector(".intro"), null);
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent.includes("重新填写"))
      .click(),
  );
  noSiteChrome();
});

for (const failure of [400, 403, 409, 500, "offline", "malformed"]) {
  test(`submission failure ${failure} keeps the independent form and answers`, async () => {
    serve(() => {
      if (failure === "offline") throw new TypeError("离线");
      if (failure === "malformed") return reply({});
      return reply(
        {
          error: "提交未确认",
          code: failure === 409 ? "SURVEY_VERSION_CONFLICT" : undefined,
        },
        failure,
      );
    });
    const { container } = await mount();
    await choose(container);
    await submit(container);
    noSiteChrome();
    assert.equal(container.querySelector("input[type=radio]").checked, true);
    assert.ok(
      surveyRecords(localStorage, "first", "draft").length ||
        surveyRecords(localStorage, "first", "pending").length,
    );
    assert.equal(container.querySelector(".success"), null);
  });
}

test("an uncertain response retries the same submission before revealing navigation", async () => {
  const bodies = [];
  serve((_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw new TypeError("响应丢失");
    return reply({ message: "原答卷已确认", completion: "completed" });
  });
  const { container } = await mount();
  await choose(container);
  await submit(container);
  noSiteChrome();
  await submit(container);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.ok(container.querySelector("nav"));
  assert.match(container.querySelector(".success").textContent, /原答卷已确认/);
});

for (const unavailable of [404, 403]) {
  test(`unavailable questionnaire ${unavailable} renders an independent status page`, async () => {
    globalThis.fetch = async (url) =>
      url.includes("/public")
        ? reply(publicData)
        : reply(
            {
              error:
                unavailable === 404 ? "问卷不存在" : "问卷尚未开始或已结束",
            },
            unavailable,
          );
    const { container } = await mount();
    noSiteChrome();
    assert.ok(container.querySelector("[role=alert]"));
    assert.match(container.textContent, /问卷暂时无法填写/);
  });
}

test("an ordinary entrance retains site navigation before submission", async () => {
  dom.window.history.replaceState(null, "", surveyVisitUrl("first"));
  serve();
  const { container } = await mount();
  assert.ok(container.querySelector("nav"));
  assert.ok(container.querySelector("a.back"));
  assert.ok(container.querySelector("footer"));
  assert.ok(container.querySelector("form"));
});

test("reload, back/forward and bfcache restoration reset the visit without using a completion marker", async () => {
  serve();
  const { container, root } = await mount();
  await choose(container);
  await submit(container);
  assert.ok(container.querySelector("nav"));
  await navigate(surveyVisitUrl("first", true), "pagehide");
  noSiteChrome();
  await navigate(surveyVisitUrl("first", true), "pageshow");
  noSiteChrome();
  await choose(container);
  await submit(container);
  await navigate(surveyVisitUrl("second", true));
  noSiteChrome();
  assert.match(container.textContent, /问卷 second/);
  assert.equal(container.querySelector(".success"), null);
  await navigate(surveyVisitUrl("first"));
  assert.ok(container.querySelector("nav"));
  await navigate(surveyVisitUrl("first", true));
  noSiteChrome();
  await choose(container);
  await submit(container);
  await act(() => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  await mount();
  noSiteChrome();
  assert.equal(container.querySelector(".success"), null);
});

test("a late success from a previous questionnaire cannot unlock the next questionnaire or erase its draft", async () => {
  const response = deferred();
  serve(() => response.promise);
  const { container } = await mount();
  await choose(container);
  await submit(container);
  await navigate(surveyVisitUrl("second", true));
  await choose(container);
  const draft = surveyRecords(localStorage, "second", "draft");
  await act(async () =>
    response.resolve(
      reply({ message: "旧访问已保存", completion: "completed" }, 201),
    ),
  );
  noSiteChrome();
  assert.equal(container.querySelector(".success"), null);
  assert.deepEqual(surveyRecords(localStorage, "second", "draft"), draft);
  assert.equal(
    surveyRecords(localStorage, "first", "pending").length,
    1,
    "the old pending receipt remains available for explicit confirmation",
  );
});

test("separate document instances never share a navigation-unlock flag even with shared storage", async () => {
  serve();
  const first = await mount();
  const second = await mount(React.createElement(App), "other-tab");
  await choose(first.container);
  await submit(first.container);
  assert.ok(first.container.querySelector("nav"));
  noSiteChrome(second.container);
  dom.window.dispatchEvent(
    new dom.window.StorageEvent("storage", {
      key: "survey-first",
      newValue: null,
    }),
  );
  noSiteChrome(second.container);
  assert.ok(second.container.querySelector("form"));
});

test("preview completion never reports a server submission", async () => {
  let confirmations = 0,
    requests = 0;
  globalThis.fetch = () => {
    requests++;
    throw new Error("preview must not send");
  };
  const { container } = await mount(
    React.createElement(Survey, {
      id: "first",
      preview: questionnaire(),
      standalone: true,
      onSubmissionSuccess: () => confirmations++,
    }),
  );
  await choose(container);
  await submit(container);
  assert.match(container.textContent, /预览完成，未保存答卷/);
  assert.equal(confirmations, 0);
  assert.equal(requests, 0);
});
