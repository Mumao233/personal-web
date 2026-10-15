import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";

let dom, vite, root, container, createRoot, ContentEditor, SurveyLinks, api;
const descriptors = new Map();
const originalFetch = globalThis.fetch;
before(async () => {
  dom = new JSDOM("<!doctype html><div id='test'></div>", {
    url: "https://isolated.example.test/?page=admin",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "FormData",
    "File",
    "MutationObserver",
    "getComputedStyle",
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ ContentEditor, SurveyLinks } = await vite.ssrLoadModule("/src/admin.jsx"));
  ({ api } = await vite.ssrLoadModule("/src/api.js"));
});
async function unmount() {
  if (root) await act(() => root.unmount());
  root = null;
}
afterEach(async () => {
  await unmount();
  globalThis.fetch = originalFetch;
});
after(async () => {
  await vite?.close();
  dom?.window.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});
async function render(element) {
  container = document.getElementById("test");
  root = createRoot(container);
  await act(async () => root.render(element));
}
const button = (text, scope = container) =>
  [...scope.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
const field = (id, name = "options") =>
  container.querySelector(
    `[data-question-id="${id}"] [data-survey-field="${name}"]`,
  );
async function click(node) {
  assert.ok(node, "control exists");
  await act(async () => node.click());
}
async function input(node, value) {
  assert.ok(node, "field exists");
  const prototype =
    node.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const question = (id, type = "single", extra = {}) => ({
  id,
  title: `问题${id}`,
  type,
  options: ["甲", "乙"],
  required: false,
  ...(type === "matrix" ? { rows: [{ id: "row-a", title: "陈述甲" }] } : {}),
  ...extra,
});
const survey = (questions) => ({
  id: "isolated-survey",
  revision: 4,
  title: "隔离编辑测试",
  published: false,
  questions,
});
async function editor(
  item,
  save = async (value) => ({ ...value, revision: 5 }),
  close = () => {},
) {
  await render(
    React.createElement(ContentEditor, {
      kind: "surveys",
      item,
      save,
      close,
      leaveEditor: { current: null },
    }),
  );
}

test("each option editor keeps raw blank lines and caret input; preview and save use the same normalization", async () => {
  for (const type of ["single", "multiple", "rank", "multirank", "matrix"]) {
    let saved;
    await editor(survey([question("raw", type)]), async (value) => {
      saved = value;
      return { ...value, revision: 5 };
    });
    const textarea = field("raw");
    textarea.focus();
    await input(textarea, "\r\n甲\r\n\r\n   \r\n 乙 \r\n");
    assert.equal(textarea.value, "\n甲\n\n   \n 乙 \n");
    assert.equal(document.activeElement, textarea);
    await input(textarea, textarea.value + "丙\n");
    assert.equal(textarea.value, "\n甲\n\n   \n 乙 \n丙\n");
    assert.equal(textarea.selectionStart, textarea.value.length);
    const raw = textarea.value;
    await click(button("预览问卷"));
    const preview = container.querySelector(".survey-preview");
    assert.ok(preview, `${type} preview renders`);
    assert.equal(
      field("raw").value,
      raw,
      "preview must not rewrite the editor",
    );
    const selector =
      type === "rank"
        ? ".ranking > div > span:nth-child(2)"
        : type === "matrix"
          ? ".matrix-mobile-label"
          : ".answer-label";
    assert.deepEqual(
      [...preview.querySelectorAll(selector)].map((node) => node.textContent),
      ["甲", " 乙 ", "丙"],
    );
    await click(button("保存"));
    assert.deepEqual(saved.questions[0].options, ["甲", " 乙 ", "丙"]);
    assert.equal(saved.revision, 4);
    await unmount();
  }
});

test("duplicate and matrix errors aggregate, link to the exact field and follow stable IDs after reorder", async () => {
  let saves = 0;
  const questions = Array.from({ length: 6 }, (_, index) =>
    question(`text-${index}`, "text", { options: ["", ""] }),
  );
  questions.push(
    question("pickup", "single", {
      title: "取餐经历",
      options: ["没有遇到", "没有遇到"],
    }),
  );
  questions.push(
    question("matrix", "matrix", {
      title: "满意度",
      options: ["满意", " ", ""],
    }),
  );
  await editor(survey(questions), async () => {
    saves++;
  });
  await click(button("保存"));
  assert.equal(saves, 0);
  const errors = container.querySelector('[aria-label="问卷校验错误"]');
  assert.match(errors.textContent, /第7题「取餐经历」.*没有遇到.*重复/);
  assert.match(errors.textContent, /第8题「满意度」.*矩阵列选项.*仅剩1项/);
  assert.equal(
    errors.querySelectorAll("li").length,
    2,
    "text questions must not be checked as options",
  );
  await click(
    [...errors.querySelectorAll("button")].find((node) =>
      node.textContent.includes("pickup"),
    ),
  );
  assert.equal(document.activeElement, field("pickup"));
  await click(
    [...errors.querySelectorAll("button")].find((node) =>
      node.textContent.includes("matrix"),
    ),
  );
  assert.equal(document.activeElement, field("matrix"));
  await click(
    container.querySelector(
      '[data-question-id="pickup"] [aria-label="上移题目"]',
    ),
  );
  assert.match(
    container.querySelector('[aria-label="问卷校验错误"]').textContent,
    /第6题「取餐经历」/,
  );
  assert.equal(field("pickup").value, "没有遇到\n没有遇到");
  await click(button("预览问卷"));
  assert.equal(container.querySelector(".survey-preview"), null);
});

test("matrix row errors focus the particular row instead of the first matrix field", async () => {
  await editor(
    survey([
      question("matrix", "matrix", {
        rows: [
          { id: "a", title: "正常" },
          { id: "b", title: "" },
        ],
      }),
    ]),
  );
  await click(button("保存"));
  const error = [
    ...container.querySelectorAll(".survey-validation-errors button"),
  ].find((node) => node.textContent.includes("第2行"));
  await click(error);
  assert.equal(
    document.activeElement,
    container.querySelector('[data-survey-row-index="1"]'),
  );
});

test("failed save preserves every raw field and does not close or falsely advance the revision", async () => {
  let sent,
    closed = 0;
  await editor(
    survey([question("keep")]),
    async (value) => {
      sent = value;
      throw Error("网络已断开");
    },
    () => closed++,
  );
  await input(field("keep"), "\n甲\n\n乙\n ");
  await input(field("keep", "title"), "仍未保存的题目");
  await input(
    container.querySelector('[data-survey-field="description"]'),
    "仍未保存的说明",
  );
  await click(button("保存"));
  assert.deepEqual(sent.questions[0].options, ["甲", "乙"]);
  assert.equal(field("keep").value, "\n甲\n\n乙\n ");
  assert.equal(field("keep", "title").value, "仍未保存的题目");
  assert.equal(
    container.querySelector('[data-survey-field="description"]').value,
    "仍未保存的说明",
  );
  assert.match(container.textContent, /网络已断开/);
  assert.equal(sent.revision, 4);
  assert.equal(closed, 0);
});

test("option editing retains termination, exclusive and downstream conditional references until explicitly repaired", async () => {
  let saved;
  await editor(
    survey([
      question("source", "multiple", {
        options: ["继续", "结束"],
        terminateOptions: ["结束"],
        exclusiveOptions: ["结束"],
      }),
      question("follow", "text", {
        condition: { questionId: "source", value: "结束" },
      }),
    ]),
    async (value) => {
      saved = value;
      return value;
    },
  );
  await input(field("source"), "继续\n结束了\n");
  await click(button("保存"));
  assert.equal(saved, undefined);
  assert.match(
    container.querySelector(".survey-validation-errors").textContent,
    /提前结束.*不存在的选项/,
  );
  assert.match(
    container.querySelector(".survey-validation-errors").textContent,
    /互斥.*不存在的选项/,
  );
  assert.match(
    container.querySelector(".survey-validation-errors").textContent,
    /条件答案.*结束/,
  );
  assert.match(container.textContent, /原选项已失效：结束/);
  const conditionError = [
    ...container.querySelectorAll(".survey-validation-errors button"),
  ].find((node) => node.textContent.includes("字段：condition"));
  await click(conditionError);
  assert.equal(document.activeElement.tagName, "SELECT");
  assert.equal(document.activeElement.closest("details").open, true);
  await input(field("source"), "继续\n结束\n");
  await click(button("保存"));
  assert.deepEqual(saved.questions[0].terminateOptions, ["结束"]);
  assert.deepEqual(saved.questions[0].exclusiveOptions, ["结束"]);
  assert.deepEqual(saved.questions[1].condition, {
    questionId: "source",
    value: "结束",
  });
});

test("server history errors pass through API, preserve unsaved text and offer field navigation", async () => {
  const issue = {
    questionId: "history",
    questionNumber: 1,
    questionTitle: "历史问卷",
    field: "options",
    code: "history_option",
    message: "第1题「历史问卷」的已有答卷使用选项“旧值”，请恢复该选项。",
  };
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      error: issue.message,
      code: "SURVEY_VALIDATION_FAILED",
      issues: [issue],
    }),
  });
  await editor(survey([question("history")]), (value) =>
    api("/admin/surveys/isolated-survey", { method: "PUT", body: value }),
  );
  await input(field("history"), "甲\n乙\n");
  await click(button("保存"));
  assert.equal(field("history").value, "甲\n乙\n");
  await click(container.querySelector(".survey-validation-errors button"));
  assert.equal(document.activeElement, field("history"));
});

test("concurrent save lock and revision conflict preserve the original draft snapshot", async () => {
  let reject,
    calls = 0;
  const pending = new Promise((resolve, fail) => {
    reject = fail;
  });
  await editor(survey([question("conflict")]), async () => {
    calls++;
    return pending;
  });
  await input(field("conflict"), "甲\n乙\n\n");
  const form = container.querySelector("form");
  await act(async () => {
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  assert.equal(calls, 1);
  assert.ok(field("conflict").matches(":disabled"));
  await act(async () =>
    reject(
      Object.assign(new Error("版本冲突"), {
        status: 409,
        code: "REVISION_CONFLICT",
      }),
    ),
  );
  assert.equal(field("conflict").value, "甲\n乙\n\n");
  assert.ok(container.querySelector('[aria-label="编辑版本冲突"]'));
  assert.equal(button("保存").disabled, true);
});

test("ordinary and standalone copy controls create distinct refreshable links without navigation or storage", async () => {
  const copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  });
  await render(React.createElement(SurveyLinks, { id: "问卷/编号" }));
  await click(button("复制普通访问链接"));
  await click(button("复制独立填写链接"));
  assert.equal(copied.length, 2);
  for (const [index, value] of copied.entries()) {
    const url = new URL(value);
    assert.equal(url.origin, "https://isolated.example.test");
    assert.equal(url.searchParams.get("survey"), "问卷/编号");
    assert.equal(url.searchParams.get("page"), "you");
    assert.equal(url.searchParams.get("standalone"), index ? "1" : null);
  }
  assert.equal(window.location.search, "?page=admin");
  assert.equal(window.localStorage.length, 0);
});
