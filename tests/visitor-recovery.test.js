import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import React, { act, Suspense, lazy } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { safeStorage } from "../src/browser-state.js";
import { unchangedAnswers } from "../src/survey-recovery.js";

let dom, vite, createRoot, root, container, Questions, Survey, Intro, Boundary;
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
    "navigator",
    "location",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "FormData",
    "File",
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
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ Questions, Intro } = await vite.ssrLoadModule("/src/main.jsx"));
  ({ default: Survey } = await vite.ssrLoadModule("/src/survey.jsx"));
  ({ default: Boundary } = await vite.ssrLoadModule(
    "/src/module-boundary.jsx",
  ));
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
  globalThis.fetch = originalFetch;
  dom.window.localStorage.clear();
});
after(async () => {
  await vite?.close();
  dom.window.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  delete globalThis.matchMedia;
});
const reply = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
async function mount(element) {
  container = document.getElementById("test");
  root = createRoot(container);
  await act(async () => root.render(element));
}
async function click(element) {
  assert.ok(element);
  await act(async () => element.click());
}
function named(text) {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent.includes(text),
  );
}
async function input(element, value) {
  const proto =
    element.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function submit(selector = "form") {
  await act(async () =>
    container
      .querySelector(selector)
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
}
const survey = () => ({
  id: "review",
  title: "问卷",
  updatedAt: "old",
  definitionVersion: "old-definition",
  questions: [
    {
      id: "q",
      title: "旧题意",
      type: "single",
      required: true,
      options: ["A", "B"],
    },
    { id: "note", title: "不变的问题", type: "text", required: false },
  ],
});

test("denied session storage uses memory and the actual greeting can close without crashing", async () => {
  const storage = safeStorage(() => {
    throw new DOMException("Denied", "SecurityError");
  });
  storage.setItem("greeted", "1");
  assert.equal(storage.getItem("greeted"), "1");
  storage.removeItem("greeted");
  assert.equal(storage.getItem("greeted"), null);
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("Denied", "SecurityError");
    },
  });
  try {
    await mount(
      React.createElement(
        "div",
        null,
        React.createElement(Intro),
        React.createElement("p", null, "页面仍可用"),
      ),
    );
    assert.match(container.textContent, /页面仍可用/);
    assert.equal(container.querySelector("[aria-label='欢迎']"), null);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", previous);
  }
});

test("a rejected lazy module leaves surrounding navigation and an explicit recovery control", async () => {
  const Broken = lazy(() => Promise.reject(Error("Synthetic chunk failure")));
  const oldError = console.error;
  console.error = () => {};
  try {
    await mount(
      React.createElement(
        "div",
        null,
        React.createElement("nav", null, "保留导航"),
        React.createElement(
          Boundary,
          { label: "地图" },
          React.createElement(
            Suspense,
            { fallback: "加载" },
            React.createElement(Broken),
          ),
        ),
      ),
    );
    assert.match(container.textContent, /保留导航/);
    assert.match(container.textContent, /地图暂时无法加载/);
    assert.ok(named("刷新页面重试"));
  } finally {
    console.error = oldError;
  }
});

test("question response-loss retry reuses the accepted logical submission and new question rotates the key", async () => {
  const bodies = [],
    saved = new Map();
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (!saved.has(body.submissionKey))
      saved.set(body.submissionKey, {
        link: "/?answer=synthetic",
        recoveryPhrase: "synthetic",
        id: body.submissionKey,
      });
    if (bodies.length === 1)
      throw new TypeError("Synthetic response loss after server acceptance");
    return reply(saved.get(body.submissionKey));
  };
  await mount(
    React.createElement(Questions, {
      data: { profile: { acceptQuestions: true }, messages: [] },
      refresh() {},
    }),
  );
  await input(container.querySelector("textarea"), "合成留言");
  await submit(".question-form");
  assert.equal(container.querySelector("fieldset").disabled, true);
  await submit(".question-form");
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(saved.size, 1);
  assert.match(container.textContent, /你的话，收到了/);
  await click(named("再留一句话"));
  await input(container.querySelector("textarea"), "第二条合成留言");
  await submit(".question-form");
  assert.equal(saved.size, 2);
  assert.notEqual(bodies[2].submissionKey, bodies[0].submissionKey);
});

test("survey response-loss retry survives remount and keeps its version/key/snapshot", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method !== "POST") return reply(survey());
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw new TypeError("Synthetic lost response");
    return reply({ message: "已确认原答卷", completion: "completed" }, 201);
  };
  await mount(React.createElement(Survey, { id: "review" }));
  await click(container.querySelector("input[type=radio]"));
  await submit();
  assert.equal(JSON.parse(localStorage.getItem("survey-review")).pending, true);
  await act(() => root.unmount());
  root = null;
  await mount(React.createElement(Survey, { id: "review" }));
  assert.match(container.textContent, /上一次提交结果尚未确认/);
  await submit();
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(bodies[0].definitionVersion, "old-definition");
  assert.ok(bodies[0].submissionKey);
  assert.match(container.textContent, /已确认原答卷/);
  assert.equal(localStorage.getItem("survey-review"), null);
});

test("survey version conflict offers recovery and only retains unchanged definitions", async () => {
  const old = survey(),
    current = structuredClone(old);
  current.definitionVersion = "new-definition";
  current.questions[0].title = "新题意";
  let gets = 0;
  globalThis.fetch = async (_url, options = {}) =>
    options.method === "POST"
      ? reply({ error: "问卷已经更新", code: "SURVEY_VERSION_CONFLICT" }, 409)
      : reply(++gets === 1 ? old : current);
  await mount(React.createElement(Survey, { id: "review" }));
  await click(container.querySelector("input[type=radio]"));
  await input(container.querySelector("textarea"), "保留此答案");
  await submit();
  assert.ok(named("下载当前填写副本"));
  await click(named("加载最新问卷"));
  assert.match(container.textContent, /新题意/);
  assert.equal(container.querySelector("input[type=radio]").checked, false);
  assert.equal(container.querySelector("textarea").value, "保留此答案");
  assert.ok(named("下载更新前的填写副本"));
  assert.deepEqual(
    unchangedAnswers(old, current, { q: "A", note: "保留此答案" }),
    { note: "保留此答案" },
  );
});

async function remountSurvey() {
  await act(() => root.unmount());
  root = null;
  await mount(React.createElement(Survey, { id: "review" }));
}

async function downloadedCopy(button) {
  let downloaded;
  const createObjectURL = URL.createObjectURL;
  const anchorClick = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    downloaded = blob;
    return createObjectURL(blob);
  };
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  try {
    await click(button);
  } finally {
    URL.createObjectURL = createObjectURL;
    dom.window.HTMLAnchorElement.prototype.click = anchorClick;
  }
  assert.ok(downloaded, "download creates a real backup blob");
  return JSON.parse(await downloaded.text());
}

for (const conflictBeforeRefresh of [false, true]) {
  test(`${conflictBeforeRefresh ? "a 409" : "an unsubmitted old draft"} survives refresh with old answers and definition available for recovery`, async () => {
    const old = survey(),
      current = structuredClone(old);
    current.updatedAt = "new";
    current.definitionVersion = "new-definition";
    current.questions[0].title = "Changed meaning after refresh";
    let latest = false;
    globalThis.fetch = async (_url, options = {}) =>
      options.method === "POST"
        ? reply(
            { error: "Changed survey", code: "SURVEY_VERSION_CONFLICT" },
            409,
          )
        : reply(latest ? current : old);
    await mount(React.createElement(Survey, { id: "review" }));
    await click(container.querySelector('input[type="radio"]'));
    await input(
      container.querySelector("textarea"),
      "Draft text preserved across refresh",
    );
    if (conflictBeforeRefresh) await submit();
    const stored = JSON.parse(localStorage.getItem("survey-review"));
    assert.equal(stored.pending, false);
    assert.deepEqual(stored.surveySnapshot, old);
    latest = true;
    await remountSurvey();
    assert.ok(named("下载当前填写副本"));
    assert.equal(container.querySelector('input[type="radio"]').checked, true);
    assert.equal(
      container.querySelector("textarea").value,
      "Draft text preserved across refresh",
    );
    assert.equal(container.querySelector("fieldset").disabled, true);
    const copy = await downloadedCopy(named("下载当前填写副本"));
    assert.equal(copy.questions[0].title, "旧题意");
    assert.deepEqual(copy.answers, {
      q: "A",
      note: "Draft text preserved across refresh",
    });
    await click(named("加载最新问卷"));
    assert.equal(container.querySelector('input[type="radio"]').checked, false);
    assert.equal(
      container.querySelector("textarea").value,
      "Draft text preserved across refresh",
    );
    assert.match(container.textContent, /Changed meaning after refresh/);
    assert.ok(named("下载更新前的填写副本"));
  });
}

test("legacy drafts without definitions remain downloadable and are never attached to current questions", async () => {
  const answers = { q: "A", note: "Unknown original question meaning" };
  localStorage.setItem(
    "survey-review",
    JSON.stringify({ revision: "legacy-before-current", answers }),
  );
  globalThis.fetch = async () => reply(survey());
  await mount(React.createElement(Survey, { id: "review" }));
  assert.ok(named("下载当前填写副本"));
  assert.equal(container.querySelector('input[type="radio"]'), null);
  const copy = await downloadedCopy(named("下载当前填写副本"));
  assert.deepEqual(copy.answers, answers);
  assert.deepEqual(copy.questions, []);
  await click(named("加载最新问卷"));
  assert.equal(container.querySelector('input[type="radio"]').checked, false);
  assert.equal(container.querySelector("textarea").value, "");
  const previous = await downloadedCopy(named("下载更新前的填写副本"));
  assert.deepEqual(previous.answers, answers);
});

test("pending submission remount can confirm its receipt even when the current survey GET would return 403", async () => {
  let gets = 0,
    closed = false;
  const bodies = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method !== "POST") {
      gets++;
      return closed ? reply({ error: "问卷已结束" }, 403) : reply(survey());
    }
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1)
      throw new TypeError("Accepted receipt response lost");
    return reply(
      { message: "Receipt confirmed after closure", completion: "completed" },
      201,
    );
  };
  await mount(React.createElement(Survey, { id: "review" }));
  await click(container.querySelector('input[type="radio"]'));
  await submit();
  closed = true;
  await remountSurvey();
  assert.equal(
    gets,
    1,
    "receipt recovery does not require an available public GET",
  );
  assert.ok(named("重试确认提交结果"));
  await submit();
  assert.deepEqual(bodies[1], bodies[0]);
  assert.match(container.textContent, /Receipt confirmed after closure/);
  assert.equal(localStorage.getItem("survey-review"), null);
});

test("a normal saved draft remains exportable when the refreshed survey is closed", async () => {
  const old = survey(),
    answers = { q: "B", note: "Saved offline copy" };
  localStorage.setItem(
    "survey-review",
    JSON.stringify({
      revision: old.updatedAt,
      definitionVersion: old.definitionVersion,
      surveySnapshot: old,
      pending: false,
      answers,
    }),
  );
  globalThis.fetch = async () => reply({ error: "问卷已结束" }, 403);
  await mount(React.createElement(Survey, { id: "review" }));
  assert.equal(
    container.querySelectorAll('input[type="radio"]')[1].checked,
    true,
  );
  assert.equal(container.querySelector("textarea").value, "Saved offline copy");
  assert.deepEqual(
    (await downloadedCopy(named("下载当前填写副本"))).answers,
    answers,
  );
  assert.deepEqual(
    JSON.parse(localStorage.getItem("survey-review")).answers,
    answers,
  );
});

test("question response loss followed by 429 and 408 retains the identical submission even after questions close", async () => {
  const bodies = [],
    receipts = new Map();
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) {
      receipts.set(body.submissionKey, {
        link: "/?answer=test",
        recoveryPhrase: "synthetic",
        id: "message-1",
      });
      throw new TypeError("Accepted response lost");
    }
    if (bodies.length === 2) return reply({ error: "Slow down" }, 429);
    if (bodies.length === 3) return reply({ error: "Request timeout" }, 408);
    return reply(receipts.get(body.submissionKey));
  };
  const props = {
    data: { profile: { acceptQuestions: true }, messages: [] },
    refresh() {},
  };
  await mount(React.createElement(Questions, props));
  await input(
    container.querySelector("textarea"),
    "Recover exactly this message",
  );
  await submit(".question-form");
  await act(async () =>
    root.render(
      React.createElement(Questions, {
        ...props,
        data: { ...props.data, profile: { acceptQuestions: false } },
      }),
    ),
  );
  for (let retry = 0; retry < 3; retry++) {
    assert.equal(named("重试确认提交结果").disabled, false);
    assert.equal(container.querySelector("fieldset").disabled, true);
    await click(named("重试确认提交结果"));
  }
  assert.equal(bodies.length, 4);
  for (const body of bodies.slice(1)) assert.deepEqual(body, bodies[0]);
  assert.equal(receipts.size, 1);
  assert.match(container.textContent, /你的话，收到了/);
});

test("survey response loss followed by 429 and 408 keeps the pending key and version through a refresh", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method !== "POST") return reply(survey());
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) throw new TypeError("Accepted response lost");
    if (bodies.length === 2) return reply({ error: "Slow down" }, 429);
    if (bodies.length === 3) return reply({ error: "Request timeout" }, 408);
    return reply(
      { message: "Same receipt recovered", completion: "completed" },
      201,
    );
  };
  await mount(React.createElement(Survey, { id: "review" }));
  await click(container.querySelector('input[type="radio"]'));
  await submit();
  for (let retry = 0; retry < 2; retry++) {
    await click(named("重试确认提交结果"));
    const stored = JSON.parse(localStorage.getItem("survey-review"));
    assert.equal(stored.pending, true);
    assert.equal(stored.submissionKey, bodies[0].submissionKey);
  }
  await remountSurvey();
  await click(named("重试确认提交结果"));
  assert.equal(bodies.length, 4);
  for (const body of bodies.slice(1)) assert.deepEqual(body, bodies[0]);
  assert.match(container.textContent, /Same receipt recovered/);
});
