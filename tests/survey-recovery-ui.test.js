import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import {
  createSurveyStorage,
  surveyStorageKeys,
} from "../src/survey-storage.js";
import { fakeSurveyLocks, surveyRecords } from "./survey-test-helpers.js";

let dom,
  vite,
  Survey,
  createRoot,
  roots = [],
  container;
const descriptors = new Map();
const originalFetch = globalThis.fetch;
before(async () => {
  dom = new JSDOM("<div id='test'></div><div id='second'></div>", {
    url: "https://example.test/?survey=review&standalone=1",
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
    "cancelAnimationFrame",
  ]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  }
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: fakeSurveyLocks(),
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ default: Survey } = await vite.ssrLoadModule("/src/survey.jsx"));
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: dom.window.localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: dom.window.sessionStorage,
  });
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: fakeSurveyLocks(),
  });
});
after(async () => {
  await vite?.close();
  dom.window.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});
const survey = (id = "review") => ({
  id,
  title: "问卷",
  updatedAt: "original",
  definitionVersion: "original-definition",
  questions: [
    {
      id: "q",
      title: "你的选择",
      type: "single",
      options: ["A", "B"],
      required: true,
    },
    { id: "note", title: "补充", type: "text" },
  ],
});
const reply = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
function memorySession() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
function serve(
  post = () => reply({ message: "保存成功", completion: "completed" }),
  get = () => reply(survey()),
) {
  globalThis.fetch = async (url, options = {}) =>
    options.method === "POST" ? post(JSON.parse(options.body)) : get(url);
}
async function mount(target = "test", props = {}) {
  container = document.getElementById(target);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      React.createElement(Survey, { id: "review", standalone: true, ...props }),
    ),
  );
  return { root, container };
}
async function unmount(root) {
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
}
const named = (text, scope = container) =>
  [...scope.querySelectorAll("button")].find(
    (button) =>
      button.textContent.trim() === text || button.textContent.startsWith(text),
  );
async function click(node) {
  assert.ok(node, "expected a rendered control");
  await act(async () => node.click());
}
async function input(value, scope = container) {
  const node = scope.querySelector("textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(scope = container) {
  await act(async () =>
    scope
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function download(button) {
  let blob;
  const originalCreate = URL.createObjectURL,
    originalClick = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (value) => {
    blob = value;
    return originalCreate(value);
  };
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  try {
    await click(button);
  } finally {
    URL.createObjectURL = originalCreate;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
  assert.ok(blob);
  return JSON.parse(await blob.text());
}
async function seed({
  answers = { q: "B", note: "保存的答案" },
  session = memorySession(),
  pending = false,
  now,
} = {}) {
  const controller = createSurveyStorage({
    surveyId: "review",
    storage: localStorage,
    session,
    locks: navigator.locks,
    ...(now ? { now } : {}),
  });
  await controller.initialize();
  await controller.saveDraft({
    surveySnapshot: survey(),
    answers,
    submissionKey: "seeded-submission-key-000001",
  });
  if (pending)
    await controller.freezePending({
      surveySnapshot: survey(),
      body: {
        answers,
        submissionKey: "seeded-submission-key-000001",
        definitionVersion: survey().definitionVersion,
      },
    });
  const state = await controller.getState();
  await controller.release();
  return state;
}

test("another tab starts blank; explicit restore refuses a live owner and preserves this tab's existing draft", async () => {
  serve();
  const first = await mount();
  await click(first.container.querySelector("input[type=radio]"));
  await input("第一个标签页", first.container);
  globalThis.sessionStorage = memorySession();
  const second = await mount("second");
  assert.equal(
    second.container.querySelector("input[type=radio]").checked,
    false,
  );
  assert.equal(second.container.querySelector("textarea").value, "");
  await click(named("恢复本机填写记录", second.container));
  assert.match(second.container.textContent, /未提交草稿/);
  assert.ok(second.container.querySelector("time"));
  await click(named("恢复此记录", second.container));
  assert.match(second.container.textContent, /其他标签页使用/);
  assert.equal(second.container.querySelector("textarea").value, "");
  await input("第二个标签页", second.container);
  await unmount(first.root);
  await click(named("恢复此记录", second.container));
  assert.ok(second.container.querySelector("[role=dialog]"));
  await click(named("确认恢复", second.container));
  assert.equal(
    second.container.querySelector("textarea").value,
    "第一个标签页",
  );
  assert.equal(surveyRecords(localStorage, "review", "draft").length, 2);
  assert.ok(
    surveyRecords(localStorage, "review", "draft").some(
      (record) => record.answers.note === "第二个标签页",
    ),
  );
});

test("turning saving off confirms deletion of only the owned record and refresh discards memory answers", async () => {
  const foreign = await seed({ pending: true });
  serve();
  const first = await mount();
  await click(container.querySelector("input[type=radio]"));
  await input("只在当前页继续");
  const ownDraft = surveyRecords(localStorage, "review", "draft").find(
    (record) => record.id !== foreign.instanceId,
  );
  await click(container.querySelector(".survey-save-choice input"));
  assert.match(
    container.querySelector("[role=dialog]").textContent,
    /刷新或关闭后无法恢复/,
  );
  assert.equal(surveyRecords(localStorage, "review", "draft").length, 2);
  await click(named("取消", container.querySelector("[role=dialog]")));
  assert.equal(
    container.querySelector(".survey-save-choice input").checked,
    true,
  );
  await click(container.querySelector(".survey-save-choice input"));
  await click(named("停止保存并删除本次本机记录"));
  assert.equal(
    container.querySelector(".survey-save-choice input").checked,
    false,
  );
  assert.equal(container.querySelector("textarea").value, "只在当前页继续");
  assert.equal(
    localStorage.getItem(surveyStorageKeys("review").draft + ownDraft.id),
    null,
  );
  assert.deepEqual(
    surveyRecords(localStorage, "review", "pending")[0].body,
    foreign.pending.body,
  );
  await input("仍只在内存");
  assert.equal(surveyRecords(localStorage, "review", "draft").length, 1);
  await unmount(first.root);
  await mount();
  assert.equal(container.querySelector("textarea").value, "");
  assert.equal(container.querySelector("input[type=radio]").checked, false);
});

test("memory-only uncertain submission keeps an immutable body and can confirm without device writes", async () => {
  const bodies = [];
  serve((body) => {
    bodies.push(body);
    if (bodies.length === 1) throw new TypeError("lost response");
    return reply({ completion: "completed", message: "原答卷已确认" });
  });
  await mount();
  await click(container.querySelector("input[type=radio]"));
  await input("原答案");
  await click(container.querySelector(".survey-save-choice input"));
  await click(named("停止保存并删除本次本机记录"));
  await submit();
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    true,
  );
  assert.equal(surveyRecords(localStorage, "review", "pending").length, 0);
  assert.equal(surveyRecords(localStorage, "review", "draft").length, 0);
  await click(named("重试确认提交结果"));
  assert.deepEqual(bodies[1], bodies[0]);
  assert.match(container.textContent, /原答卷已确认/);
});

test("deleting an unknown submission requires an explicit duplicate warning and never submits automatically", async () => {
  let posts = 0;
  serve(() => {
    posts++;
    throw new TypeError("lost response");
  });
  await mount();
  await click(container.querySelector("input[type=radio]"));
  await submit();
  const pending = surveyRecords(localStorage, "review", "pending")[0];
  await click(named("删除本次恢复记录"));
  const dialog = container.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /不会撤销服务器上可能已经保存的答卷/);
  assert.match(dialog.textContent, /另一份答卷和统计记录/);
  await click(named("取消", dialog));
  assert.deepEqual(
    surveyRecords(localStorage, "review", "pending")[0],
    pending,
  );
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    true,
  );
  await click(named("删除本次恢复记录"));
  await click(named("确认删除"));
  assert.equal(posts, 1);
  assert.equal(surveyRecords(localStorage, "review", "pending").length, 0);
  assert.equal(container.querySelector("input[type=radio]").checked, false);
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    false,
  );
});

test("clearing answers requires confirmation and preserves values on cancel", async () => {
  serve();
  await mount();
  await click(container.querySelector("input[type=radio]"));
  await input("保留到确认");
  await click(named("清除当前答案"));
  assert.match(
    container.querySelector("[role=dialog]").textContent,
    /清除本次尚未提交/,
  );
  await click(named("取消", container.querySelector("[role=dialog]")));
  assert.equal(container.querySelector("textarea").value, "保留到确认");
  await click(named("清除当前答案"));
  await click(named("确认清除"));
  assert.equal(container.querySelector("textarea").value, "");
  assert.equal(surveyRecords(localStorage, "review", "draft").length, 0);
});

test("submission-key conflict persists across refresh; explicit new attempt keeps answers and changes only the key", async () => {
  const bodies = [];
  serve((body) => {
    bodies.push(body);
    return bodies.length === 1
      ? reply({ error: "标识已使用", code: "SUBMISSION_KEY_CONFLICT" }, 409)
      : reply({ completion: "completed", message: "新答卷已保存" });
  });
  const first = await mount();
  await click(container.querySelector("input[type=radio]"));
  await input("需要保留");
  await submit();
  assert.ok(named("下载当前答案"));
  assert.ok(named("保留当前答案，开始新一次填写"));
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    true,
  );
  await unmount(first.root);
  await mount();
  assert.ok(named("保留当前答案，开始新一次填写"));
  assert.equal(container.querySelector("textarea").value, "需要保留");
  await click(named("保留当前答案，开始新一次填写"));
  assert.match(
    container.querySelector("[role=dialog]").textContent,
    /计入统计/,
  );
  await click(named("确认开始新一次填写"));
  assert.equal(bodies.length, 1, "confirmation never sends a POST");
  assert.equal(container.querySelector("textarea").value, "需要保留");
  await submit();
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[1].submissionKey, bodies[0].submissionKey);
  assert.deepEqual(bodies[1].answers, bodies[0].answers);
  assert.equal(bodies[1].definitionVersion, bodies[0].definitionVersion);
});

test("initial GET retry preserves same-tab draft without extending its edit time", async () => {
  const before = await seed({
    session: sessionStorage,
    now: () => Date.now() - 60_000,
  });
  let gets = 0;
  serve(undefined, () => {
    if (++gets === 1) throw new TypeError("temporarily offline");
    return reply(survey());
  });
  await mount();
  assert.equal(container.querySelector("textarea").value, "保存的答案");
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    true,
  );
  assert.ok(named("下载当前填写副本"));
  await click(named("重新加载问卷"));
  assert.equal(container.querySelector("textarea").value, "保存的答案");
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    false,
  );
  assert.equal(
    surveyRecords(localStorage, "review", "draft")[0].updatedAt,
    before.draft.updatedAt,
  );
});

test("loading a changed definition does not silently clear a previously confirmed key conflict", async () => {
  let latest = survey(),
    posts = 0;
  serve(
    () => {
      posts++;
      return reply(
        { error: "标识已使用", code: "SUBMISSION_KEY_CONFLICT" },
        409,
      );
    },
    () => reply(latest),
  );
  const first = await mount();
  await click(container.querySelector("input[type=radio]"));
  await input("未变的问题继续保留");
  await submit();
  const oldKey = surveyRecords(localStorage, "review", "draft")[0]
    .submissionKey;
  latest = structuredClone(latest);
  latest.definitionVersion = "new-definition";
  latest.questions[0].title = "已经修改的问题";
  await unmount(first.root);
  await mount();
  await click(named("加载最新问卷"));
  assert.equal(container.querySelector("textarea").value, "未变的问题继续保留");
  assert.equal(container.querySelector("input[type=radio]").checked, false);
  assert.ok(named("保留当前答案，开始新一次填写"));
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    true,
  );
  assert.equal(
    surveyRecords(localStorage, "review", "draft")[0].submissionKey,
    oldKey,
  );
  assert.equal(
    surveyRecords(localStorage, "review", "draft")[0].submissionConflict,
    true,
  );
  assert.equal(posts, 1);
});

test("no Web Locks means explicit recovery after refresh with a visible limitation", async () => {
  await seed({ session: sessionStorage });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
  serve();
  await mount();
  assert.equal(container.querySelector("textarea").value, "");
  assert.match(container.textContent, /不支持标签页独占锁/);
  assert.doesNotMatch(
    container.textContent,
    /本标签页刷新后自动恢复|本标签页刷新后可继续/,
  );
  await click(named("恢复本机填写记录"));
  await click(named("恢复此记录"));
  assert.equal(container.querySelector("textarea").value, "保存的答案");
});

test("a never-settling definition GET times out and can be retried without losing the original draft", async () => {
  const state = await seed({ session: sessionStorage });
  let gets = 0,
    initialSignal;
  globalThis.fetch = async (_url, options) => {
    if (++gets === 1) {
      initialSignal = options.signal;
      return new Promise(() => {});
    }
    return reply(survey());
  };
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalTimeout(callback, delay === 15000 ? 5 : delay, ...args);
  try {
    await mount();
    await act(
      async () => new Promise((resolve) => originalTimeout(resolve, 15)),
    );
    assert.equal(initialSignal.aborted, true);
    assert.match(container.textContent, /问卷加载超时/);
    assert.equal(container.querySelector("textarea").value, "保存的答案");
    await click(named("重新加载问卷"));
    assert.equal(container.querySelector("textarea").value, "保存的答案");
    assert.equal(
      surveyRecords(localStorage, "review", "draft")[0].updatedAt,
      state.draft.updatedAt,
    );
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});

for (const oldOutcome of ["resolve", "reject"]) {
  test(`restoring pending while initial GET is unresolved ignores its later ${oldOutcome}`, async () => {
    const saved = await seed({ pending: true });
    let resolveGet,
      rejectGet,
      posts = [];
    globalThis.fetch = async (_url, options = {}) => {
      if (options.method === "POST") {
        posts.push(JSON.parse(options.body));
        return reply({ completion: "completed", message: "原答卷确认完成" });
      }
      return new Promise((resolve, reject) => {
        resolveGet = resolve;
        rejectGet = reject;
      });
    };
    await mount();
    assert.match(container.textContent, /正在打开问卷/);
    await click(named("恢复本机填写记录"));
    await click(named("恢复此记录"));
    assert.ok(named("重试确认提交结果"));
    assert.equal(named("重试确认提交结果").disabled, false);
    assert.equal(container.querySelector("textarea").value, "保存的答案");
    await act(async () => {
      if (oldOutcome === "resolve")
        resolveGet(reply({ ...survey(), title: "不应覆盖原快照的新问卷" }));
      else rejectGet(new TypeError("old GET failed"));
    });
    assert.doesNotMatch(
      container.textContent,
      /不应覆盖原快照的新问卷|old GET failed|已取消本次问卷加载/,
    );
    assert.equal(named("重试确认提交结果").disabled, false);
    await click(named("重试确认提交结果"));
    assert.deepEqual(posts, [saved.pending.body]);
    assert.match(container.textContent, /原答卷确认完成/);
  });
}

test("malformed legacy recovery downloads the exact original bytes instead of inventing empty answers", async () => {
  const raw = '{  "answers": {"q":"A"}, "extra":" keep spaces "  BROKEN\r\n';
  localStorage.setItem("survey-review", raw);
  serve();
  await mount();
  await click(named("恢复本机填写记录"));
  assert.equal(named("恢复此记录"), undefined);
  const exported = await download(named("下载此记录"));
  assert.equal(exported.originalText, raw);
  assert.equal(exported.recoveryRecord.legacyRaw, raw);
  assert.equal(Object.hasOwn(exported, "answers"), false);
  assert.equal(container.querySelector("input[type=radio]").checked, false);
});

test("known rejection with a failed local cleanup keeps the immutable request locked and retryable", async () => {
  const savedStorage = dom.window.localStorage;
  let denied = true;
  globalThis.localStorage = {
    get length() {
      return savedStorage.length;
    },
    key: (index) => savedStorage.key(index),
    getItem: (key) => savedStorage.getItem(key),
    setItem: (key, value) => savedStorage.setItem(key, value),
    removeItem(key) {
      if (denied && key.includes(":pending:"))
        throw new DOMException("denied delete", "SecurityError");
      savedStorage.removeItem(key);
    },
  };
  const bodies = [];
  serve((body) => {
    bodies.push(body);
    return bodies.length === 1
      ? reply({ error: "明确拒绝" }, 400)
      : reply({ completion: "completed", message: "原请求已确认" });
  });
  await mount();
  await click(container.querySelector("input[type=radio]"));
  await submit();
  assert.match(container.textContent, /原请求继续保持锁定/);
  assert.equal(
    container.querySelector(".survey-active-section").disabled,
    true,
  );
  assert.equal(surveyRecords(savedStorage, "review", "pending").length, 1);
  denied = false;
  await click(named("重试确认提交结果"));
  assert.deepEqual(bodies[1], bodies[0]);
  assert.match(container.textContent, /原请求已确认/);
});

test("storage denial leaves the form usable and reports memory-only recovery", async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Denied", "SecurityError");
    },
  });
  const bodies = [];
  serve((body) => {
    bodies.push(body);
    return reply({ completion: "completed", message: "无存储也可提交" });
  });
  await mount();
  assert.match(container.textContent, /本机保存不可用/);
  await click(container.querySelector("input[type=radio]"));
  await input("内存答案");
  await submit();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].answers.note, "内存答案");
  assert.match(container.textContent, /无存储也可提交/);
});

test("section transitions focus their heading while validation still focuses the invalid question", async () => {
  const definition = survey();
  definition.questions[0].section = "第一部分";
  definition.questions[1].section = "第二部分";
  serve(undefined, () => reply(definition));
  await mount();
  await click(container.querySelector("input[type=radio]"));
  await click(named("下一部分"));
  assert.equal(
    document.activeElement,
    container.querySelector(".section-head h2"),
  );
  assert.equal(document.activeElement.textContent, "第二部分");
  await click(named("上一部分"));
  assert.equal(
    document.activeElement,
    container.querySelector(".section-head h2"),
  );
  assert.equal(document.activeElement.textContent, "第一部分");
  await click(named("清除当前答案"));
  await click(named("确认清除"));
  await click(named("下一部分"));
  await act(
    async () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  assert.equal(document.activeElement.id, "question-q");
});
