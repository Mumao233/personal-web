import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { localDate, latestRequest } from "../src/editor-state.js";
import { cluster, distanceKm } from "../src/map-utils.js";

let dom,
  vite,
  root,
  container,
  createRoot,
  Profile,
  ContentEditor,
  Admin,
  Notifications,
  World,
  useDraftPublishing,
  api;
const originalFetch = globalThis.fetch;
const descriptors = new Map();
before(async () => {
  dom = new JSDOM("<!doctype html><div id='test'></div>", {
    url: "http://localhost/",
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
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({
    Profile,
    ContentEditor,
    Notifications,
    default: Admin,
  } = await vite.ssrLoadModule("/src/admin.jsx"));
  ({ default: World } = await vite.ssrLoadModule("/src/world.jsx"));
  ({ default: useDraftPublishing } = await vite.ssrLoadModule(
    "/src/use-draft-publishing.js",
  ));
  ({ api } = await vite.ssrLoadModule("/src/api.js"));
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
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
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const reply = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
async function render(element) {
  container = document.getElementById("test");
  root = createRoot(container);
  await act(async () => root.render(element));
}
const button = (text) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
const field = (text) =>
  [...container.querySelectorAll("label")]
    .find(
      (node) =>
        [...node.childNodes]
          .filter((child) => child.nodeType === 3)
          .map((child) => child.textContent)
          .join("")
          .trim() === text,
    )
    ?.querySelector("input, textarea");
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
const profile = {
  revision: 0,
  name: "Synthetic",
  email: "qa@example.invalid",
  phone: "",
  wechat: "",
  github: "",
  intro: "original",
  bio: "biography",
  interests: [],
  timeline: [],
};
const survey = {
  id: "survey-1",
  revision: 2,
  title: "Original title",
  description: "description",
  questions: [{ id: "recovery-question", title: "填写内容", type: "text" }],
  published: false,
};

test("API errors retain HTTP status and conflict code", async () => {
  globalThis.fetch = async () =>
    reply({ error: "stale", code: "REVISION_CONFLICT" }, 409);
  await assert.rejects(
    api("/admin/profile"),
    (error) => error.status === 409 && error.code === "REVISION_CONFLICT",
  );
});

test("delayed portrait upload preserves edits made during the upload", async () => {
  const pending = deferred();
  let saved;
  globalThis.fetch = () => pending.promise;
  await render(
    React.createElement(Profile, {
      data: profile,
      save: async (value) => {
        saved = value;
        return { ...value, revision: 1 };
      },
      leaveEditor: { current: null },
    }),
  );
  const file = container.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", {
    value: [new window.File(["image"], "qa.png", { type: "image/png" })],
  });
  await act(async () =>
    file.dispatchEvent(new window.Event("change", { bubbles: true })),
  );
  await input(field("首页短介绍"), "written while uploading");
  await act(async () =>
    pending.resolve(reply({ files: [{ url: "/uploads/synthetic.png" }] })),
  );
  assert.equal(field("首页短介绍").value, "written while uploading");
  await click(button("保存资料"));
  assert.equal(saved.intro, "written while uploading");
  assert.equal(saved.portrait, "/uploads/synthetic.png");
  assert.equal(saved.revision, 0);
});

test("profile conflict retains local edits and reloads the latest visibility settings", async () => {
  globalThis.fetch = async () =>
    reply({
      profile: {
        ...profile,
        revision: 3,
        intro: "remote",
        email: "",
        fields: [],
      },
    });
  const conflict = Object.assign(new Error("stale"), {
    status: 409,
    code: "REVISION_CONFLICT",
  });
  await render(
    React.createElement(Profile, {
      data: profile,
      save: async () => {
        throw conflict;
      },
      leaveEditor: { current: null },
    }),
  );
  await input(field("首页短介绍"), "local draft");
  await click(button("保存资料"));
  assert.ok(container.querySelector('[aria-label="编辑版本冲突"]'));
  assert.equal(field("首页短介绍").value, "local draft");
  await click(button("复制本地修改"));
  assert.equal(
    JSON.parse(container.querySelector('[aria-label="本地修改备份"]').value)
      .intro,
    "local draft",
  );
  await click(button("放弃本地修改并载入最新版"));
  assert.equal(field("首页短介绍").value, "remote");
  assert.equal(container.querySelector('[aria-label="编辑版本冲突"]'), null);
});

test("survey leave offers cancel, save or discard instead of silently dropping edits", async () => {
  let closed = 0,
    saved = 0;
  await render(
    React.createElement(ContentEditor, {
      kind: "surveys",
      item: survey,
      save: async (value) => {
        saved++;
        return { ...value, revision: 3 };
      },
      close: () => closed++,
      leaveEditor: { current: null },
    }),
  );
  await input(field("标题"), "Changed title");
  await click(button("返回列表"));
  assert.equal(closed, 0);
  assert.ok(container.querySelector('[aria-label="未保存的修改"]'));
  await click(button("继续编辑"));
  assert.equal(closed, 0);
  assert.equal(field("标题").value, "Changed title");
  await click(button("返回列表"));
  await click(button("保存并离开"));
  assert.equal(saved, 1);
  assert.equal(closed, 1);
});

test("survey save locks fields until the sent snapshot succeeds", async () => {
  const pending = deferred();
  let snapshot,
    closed = 0;
  await render(
    React.createElement(ContentEditor, {
      kind: "surveys",
      item: survey,
      save: async (value) => {
        snapshot = value;
        return pending.promise;
      },
      close: () => closed++,
      leaveEditor: { current: null },
    }),
  );
  await input(field("标题"), "Sent title");
  await click(button("保存"));
  assert.ok(field("标题").matches(":disabled"));
  assert.equal(closed, 0);
  assert.ok(container.querySelector(".editor-save input").matches(":disabled"));
  await act(async () => pending.resolve({ ...snapshot, revision: 3 }));
  assert.equal(closed, 1);
  assert.equal(snapshot.title, "Sent title");
  assert.equal(snapshot.revision, 2);
});

test("discarding survey changes navigates without sending them and dirty reloads are guarded", async () => {
  let closed = 0,
    saves = 0;
  await render(
    React.createElement(ContentEditor, {
      kind: "surveys",
      item: survey,
      save: async () => {
        saves++;
      },
      close: () => closed++,
      leaveEditor: { current: null },
    }),
  );
  await input(field("标题"), "Unsaved title");
  const unload = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  await click(button("返回列表"));
  await click(button("放弃修改并离开"));
  assert.equal(closed, 1);
  assert.equal(saves, 0);
});

test("survey conflict can be discarded and reloaded without overwriting remote data", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return reply({ ...survey, revision: 5, title: "Newest title" });
  };
  await render(
    React.createElement(ContentEditor, {
      kind: "surveys",
      item: survey,
      save: async () => {
        throw Object.assign(new Error("stale"), { status: 409 });
      },
      close: () => {},
      leaveEditor: { current: null },
    }),
  );
  await input(field("标题"), "Old tab edit");
  await click(button("保存"));
  assert.equal(field("标题").value, "Old tab edit");
  await click(button("放弃本地修改并载入最新版"));
  assert.equal(field("标题").value, "Newest title");
  assert.deepEqual(requests, ["/api/admin/surveys/survey-1"]);
});

test("article conflict stops automatic retries, supports reload and leaves normally afterwards", async () => {
  let hook,
    setValue,
    requestCount = 0;
  const initial = { id: "post-1", revision: 1, title: "Original" };
  globalThis.fetch = async () => {
    requestCount++;
    return reply({ error: "stale", code: "REVISION_CONFLICT" }, 409);
  };
  function Harness() {
    const [value, change] = useState(initial);
    setValue = change;
    hook = useDraftPublishing("posts", initial, value, false);
    return null;
  }
  await render(React.createElement(Harness));
  await act(async () => setValue({ ...initial, title: "Local" }));
  await act(async () => {
    await assert.rejects(hook.save());
  });
  assert.equal(hook.conflict, true);
  assert.equal(await hook.leave(), false);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1250)));
  assert.equal(requestCount, 1);
  const latest = { ...initial, revision: 4, title: "Remote" };
  await act(async () => {
    hook.reset(latest, latest);
    setValue(latest);
  });
  let canLeave;
  await act(async () => {
    canLeave = await hook.leave();
  });
  assert.equal(canLeave, true);
  assert.equal(hook.conflict, false);
  assert.equal(requestCount, 1);
});

test("logout clears the old article editor and the next login opens the latest draft", async () => {
  let loggedIn = true;
  let article = {
    id: "post-1",
    revision: 1,
    title: "Article",
    body: "Initial body",
    published: false,
  };
  const revisions = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === "/api/admin")
      return loggedIn
        ? reply({
            profile,
            posts: [article],
            projects: [],
            stories: [],
            surveys: [],
            messages: [],
          })
        : reply({ error: "login required" }, 401);
    if (url === "/api/status") return reply({ needsSetup: false });
    if (url === "/api/logout") {
      loggedIn = false;
      return reply({ ok: true });
    }
    if (url === "/api/login") {
      loggedIn = true;
      return reply({ ok: true });
    }
    if (url === "/api/admin/posts/post-1/draft") {
      const data = JSON.parse(options.body);
      revisions.push(data.revision);
      article = { ...article, revision: article.revision + 1, draft: data };
      return reply(article);
    }
    throw Error(`Unexpected request ${url}`);
  };
  await render(React.createElement(Admin));
  await click(button("随笔"));
  await click(button("编辑"));
  await input(field("标题"), "Saved before logout");
  await click(button("保存草稿"));
  await click(button("退出"));
  assert.ok(container.querySelector(".admin-login"));
  await input(field("用户名"), "qa");
  await input(field("密码"), "synthetic-password");
  await click(button("登录"));
  assert.equal(
    container.querySelector(".admin-heading h1").textContent,
    "个人资料",
  );
  await click(button("随笔"));
  assert.ok(container.querySelector(".admin-list"));
  await click(button("编辑"));
  assert.equal(field("标题").value, "Saved before logout");
  await input(field("标题"), "New edit after login");
  await click(button("保存草稿"));
  assert.deepEqual(revisions, [1, 2]);
});

test("article conflict reload replaces the rich document as well as form metadata", async () => {
  const article = {
    id: "post-reload",
    revision: 1,
    title: "Original",
    body: "Original rich body",
  };
  globalThis.fetch = async (url) =>
    url.endsWith("/draft")
      ? reply({ error: "stale", code: "REVISION_CONFLICT" }, 409)
      : reply({
          ...article,
          revision: 4,
          title: "Latest",
          body: "Latest rich body",
        });
  await render(
    React.createElement(ContentEditor, {
      kind: "posts",
      item: article,
      save: async () => {},
      close: () => {},
      leaveEditor: { current: null },
    }),
  );
  await input(field("标题"), "Local title");
  await click(button("保存草稿"));
  assert.ok(container.querySelector('[aria-label="编辑版本冲突"]'));
  await click(button("放弃本地修改并载入最新版"));
  assert.equal(field("标题").value, "Latest");
  assert.equal(
    container.querySelector(".rich-editor-document").textContent,
    "Latest rich body",
  );
});

test("out of order place responses cannot replace the current query results", async () => {
  const a = deferred(),
    b = deferred();
  globalThis.fetch = async (url) => {
    if (url === "/api/geocode?q=AA") return a.promise;
    if (url === "/api/geocode?q=BB") return b.promise;
    if (url === "/assets/countries.json") return reply({ features: [] });
    throw Error(`Unexpected request ${url}`);
  };
  await render(
    React.createElement(ContentEditor, {
      kind: "stories",
      item: { id: "qa-story", revision: 0, title: "Story", body: "Text" },
      save: async () => {},
      close: () => {},
      leaveEditor: { current: null },
    }),
  );
  await input(field("搜索地址或城市"), "AA");
  await click(button("向 Nominatim 查询此文字"));
  await input(field("搜索地址或城市"), "BB");
  await click(button("向 Nominatim 查询此文字"));
  await act(async () =>
    b.resolve(
      reply([{ display_name: "Current place B", lat: "23", lon: "113" }]),
    ),
  );
  assert.equal(
    container.querySelector(".place-result").textContent,
    "设为原始精确位置：Current place B",
  );
  await act(async () =>
    a.resolve(
      reply([{ display_name: "Stale place A", lat: "22", lon: "110" }]),
    ),
  );
  assert.equal(
    container.querySelector(".place-result").textContent,
    "设为原始精确位置：Current place B",
  );
});

test("cancelled and in-flight notification rows reveal no contact and offer no retry", async () => {
  await render(
    React.createElement(Notifications, {
      state: {
        notifications: {},
        outbox: [
          { id: "cancelled", status: "cancelled" },
          { id: "sending", status: "sending" },
        ],
      },
      attempt: async () => {},
      busy: false,
    }),
  );
  assert.equal(container.querySelectorAll(".outbox-row").length, 2);
  assert.equal(container.querySelectorAll(".outbox-row button").length, 0);
  assert.equal(
    container.querySelector(".outbox-row strong").textContent,
    "联系方式已清除",
  );
});

test("map toolbar cannot submit its enclosing publishing form and space opens a marker", async () => {
  globalThis.fetch = async () => reply({ features: [] });
  let submits = 0;
  const stories = [
    { id: "qa", city: "QA city", title: "Synthetic story", lat: 23, lng: 113 },
  ];
  const nativeForm = document.createElement("form");
  nativeForm.innerHTML = renderToStaticMarkup(
    React.createElement(World, { stories }),
  );
  nativeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
  document.body.append(nativeForm);
  for (const node of nativeForm.querySelectorAll("button")) node.click();
  assert.equal(submits, 0);
  nativeForm.remove();
  await render(
    React.createElement(
      "form",
      {
        onSubmit: (event) => {
          event.preventDefault();
          submits++;
        },
      },
      React.createElement(World, { stories }),
    ),
  );
  await click(button("平面地图"));
  assert.equal(submits, 0);
  const marker = container.querySelector('g[role="button"]');
  assert.ok(marker);
  const event = new window.KeyboardEvent("keydown", {
    key: " ",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => marker.dispatchEvent(event));
  assert.equal(event.defaultPrevented, true);
  assert.ok(container.querySelector(".story-detail"));
  await click(container.querySelector('[aria-label="关闭故事"]'));
  assert.equal(submits, 0);
});

test("same-name cities remain separate and nearby points cross the dateline correctly", () => {
  assert.equal(
    cluster(
      [
        { city: "Paris", lat: 48.8566, lng: 2.3522 },
        { city: "Paris", lat: 33.6609, lng: -95.5555 },
      ],
      true,
    ).length,
    2,
  );
  assert.equal(
    cluster(
      [
        { city: "A", lat: 0, lng: 179.9 },
        { city: "B", lat: 0, lng: -179.9 },
      ],
      true,
    ).length,
    1,
  );
  assert.ok(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) > 111);
});

test("local calendar dates and invalidated search responses stay aligned with the user's input", () => {
  const date = new Date(2026, 9, 14, 0, 30);
  assert.equal(localDate(date), "2026-10-14");
  const search = latestRequest(),
    a = search.next(),
    b = search.next();
  assert.equal(search.isCurrent(a), false);
  assert.equal(search.isCurrent(b), true);
  search.invalidate();
  assert.equal(search.isCurrent(b), false);
});
