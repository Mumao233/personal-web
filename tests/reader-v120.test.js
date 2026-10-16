import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import {
  isCalendarDate,
  calendarDateAt,
  formatContentDate,
  contentDateValue,
} from "../shared/content-date.js";
import {
  resolvePageRoute,
  buildPublicPageMetadata,
} from "../shared/page-info.js";
import { injectPageMetadata } from "../server/page-metadata.js";
import { cluster } from "../src/map-utils.js";

let dom,
  vite,
  root,
  createRoot,
  ArticleContent,
  articlePhotos,
  safePdfSource,
  App;
const originalFetch = globalThis.fetch;
const originals = new Map();
before(async () => {
  dom = new JSDOM(
    "<button id='before'>之前的按钮</button><div id='app'></div>",
    { url: "https://mumao.site/", pretendToBeVisual: true },
  );
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
    "KeyboardEvent",
    "localStorage",
    "sessionStorage",
    "matchMedia",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
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
  ({ default: ArticleContent } = await vite.ssrLoadModule(
    "/src/article-content.jsx",
  ));
  ({ articlePhotos, safePdfSource } = await vite.ssrLoadModule(
    "/src/media-viewer.jsx",
  ));
  ({ default: App } = await vite.ssrLoadModule("/src/main.jsx"));
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
  globalThis.fetch = originalFetch;
});
after(async () => {
  await vite?.close();
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});
const render = async (item, kind = "story") => {
  root = createRoot(document.getElementById("app"));
  await act(() =>
    root.render(React.createElement(ArticleContent, { item, kind })),
  );
};
const click = async (node) => {
  node.focus();
  await act(() =>
    node.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
};
const key = async (value, shiftKey = false) => {
  await act(() =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
};

test("calendar dates are strict and timestamps follow Shanghai rather than viewer timezone", () => {
  assert.equal(isCalendarDate("2024-02-29"), true);
  for (const value of [
    "2023-02-29",
    "2026-02-31",
    "2026-13-01",
    "2026-10-00",
    "2026-1-01",
    "2026-10-13 ",
  ])
    assert.equal(isCalendarDate(value), false);
  assert.equal(formatContentDate("2026-10-13"), "2026/10/13");
  assert.equal(calendarDateAt("2026-10-13T16:01:00.000Z"), "2026-10-14");
  assert.equal(calendarDateAt("2026-10-13T01:00:00+09:00"), "2026-10-13");
  assert.equal(calendarDateAt("2026-10-13T16:01:00"), "");
  assert.equal(formatContentDate("2026-02-31"), "");
  assert.equal(
    contentDateValue(
      { date: "2020-01-01", publishedAt: "2026-10-13T16:01:00Z" },
      "posts",
    ),
    "2020-01-01",
  );
  assert.equal(
    contentDateValue({ createdAt: "2026-10-13T16:01:00Z" }, "stories"),
    "",
  );
});

test("route ownership follows displayed content for survey and conflicting URL parameters", () => {
  assert.equal(resolvePageRoute("/?survey=abc").page, "you");
  assert.equal(resolvePageRoute("/?page=notes&project=p").page, "projects");
  assert.equal(resolvePageRoute("/?page=world&post=p&survey=s").page, "you");
  assert.equal(resolvePageRoute("/?page=admin&story=s").page, "world");
  assert.equal(resolvePageRoute("/?answer=secret&project=p").private, true);
});

test("server metadata is escaped, canonicalized and never reads private answers or draft content", () => {
  const publicData = {
    profile: { name: '林<&"' },
    projects: [
      {
        id: "p",
        title: "报告 </title><script>alert(1)</script>",
        excerpt: '描述 " & <meta>',
        cover: "/uploads/test.jpg",
        draft: { title: "草稿秘密" },
      },
    ],
    questions: [{ answer: "私密回答" }],
  };
  const metadata = buildPublicPageMetadata({
    url: "/?page=notes&project=p&utm_source=x",
    origin: "https://mumao.site",
    publicData,
  });
  assert.equal(
    metadata.canonical,
    "https://mumao.site/?page=projects&project=p",
  );
  assert.equal(metadata.image, "https://mumao.site/uploads/test.jpg");
  const html = injectPageMetadata(
    '<html><head><title>旧标题</title><meta name="description" content="old"></head></html>',
    metadata,
  );
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.doesNotMatch(html, /<script>|草稿秘密|私密回答|旧标题/);
  assert.match(html, /&quot;/);
  assert.match(html, /property="og:title"/);
  const privatePage = buildPublicPageMetadata({
    url: "/?answer=secret-token",
    publicData,
  });
  assert.equal(privatePage.noindex, true);
  assert.equal(privatePage.canonical.includes("secret-token"), false);
  const missing = buildPublicPageMetadata({
    url: "/?project=missing",
    publicData,
  });
  assert.equal(missing.noindex, true);
  const unpublished = buildPublicPageMetadata({
    url: "/?project=p",
    publicData: {
      projects: [{ id: "p", title: "未发布秘密", published: false }],
    },
  });
  assert.equal(unpublished.title.includes("未发布秘密"), false);
  assert.throws(() =>
    buildPublicPageMetadata({
      url: "/",
      origin: "https://trusted.example/evil",
    }),
  );
});

test("map includes only valid public positions and keeps real zero coordinates", () => {
  const rows = [
    { id: "hidden", lat: 1, lng: 1, locationPrecision: "hidden" },
    { id: "missing" },
    { id: "blank", lat: "", lng: "" },
    { id: "invalid", lat: 91, lng: 0 },
    { id: "zero", lat: 0, lng: 0 },
    { id: "city", lat: 23, lng: 113, locationPrecision: "city" },
  ];
  assert.deepEqual(
    cluster(rows, false).map((item) => item.id),
    ["zero", "city"],
  );
  assert.equal(cluster(rows, true).length, 2);
});

test("article photo sequence deduplicates cover, rich body and album and merges captions", () => {
  const photos = articlePhotos({
    title: "故事",
    cover: "/uploads/a.jpg",
    content: {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "https://mumao.site/uploads/a.jpg",
            caption: "正文图注",
          },
        },
        { type: "image", attrs: { src: "/uploads/b.jpg" } },
      ],
    },
    photos: ["/uploads/a.jpg", "/uploads/c.jpg", "/uploads/c.jpg"],
    photoDetails: [
      {
        src: "/uploads/c.jpg",
        alt: "街角",
        caption: "雨后",
        takenAt: "2020-01-01",
      },
    ],
  });
  assert.equal(photos.length, 3);
  assert.equal(photos[0].caption, "正文图注");
  assert.equal(photos[2].alt, "街角");
  assert.equal(photos[2].takenAt, "2020-01-01");
});

test("viewer supports keyboard navigation, focus trap, Escape and focus restoration", async () => {
  await render({
    title: "故事",
    cover: "/uploads/a.jpg",
    photos: ["/uploads/a.jpg", "/uploads/b.jpg"],
    photoDetails: [
      { src: "/uploads/b.jpg", alt: "第二张", caption: "照片说明" },
    ],
  });
  const opener = document.querySelector(".article-cover-open");
  await click(opener);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(document.getElementById("app").hasAttribute("inert"), true);
  assert.equal(
    document.activeElement.getAttribute("aria-label"),
    "关闭照片查看器",
  );
  await key("ArrowRight");
  assert.equal(
    dialog.querySelector(".viewer-stage img").getAttribute("src"),
    "/uploads/b.jpg",
  );
  assert.match(dialog.textContent, /照片说明/);
  const buttons = dialog.querySelectorAll("button:not(:disabled)");
  buttons[buttons.length - 1].focus();
  await key("Tab");
  assert.equal(document.activeElement, buttons[0]);
  await key("Tab", true);
  assert.equal(document.activeElement, buttons[buttons.length - 1]);
  await key("Escape");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, opener);
  assert.equal(document.getElementById("app").hasAttribute("inert"), false);
});

test("PDF area renders only safe local PDFs with explicit new-window preview and download", async () => {
  for (const src of [
    "https://evil.example/a.pdf",
    "//evil.example/a.pdf",
    "/uploads/../secret.pdf",
    "/uploads/a.pdf?evil=x",
    "javascript:alert(1)",
    "/uploads/a.html",
  ])
    assert.equal(safePdfSource(src), "");
  await render(
    {
      title: "项目",
      attachments: [
        {
          src: "/uploads/report.pdf",
          name: "报告.pdf",
          size: 1024,
          version: "v1",
          date: "2026-10-14",
        },
        { src: "https://evil.example/a.pdf", name: "不可见" },
      ],
    },
    "project",
  );
  assert.equal(document.querySelector("iframe"), null);
  assert.doesNotMatch(document.getElementById("app").textContent, /不可见/);
  const preview = [...document.querySelectorAll("a")].find(
    (link) => link.textContent === "预览 PDF（新窗口）",
  );
  assert.equal(preview.getAttribute("href"), "/uploads/report.pdf");
  assert.equal(preview.getAttribute("target"), "_blank");
  assert.match(preview.getAttribute("rel"), /noopener/);
  assert.equal(
    document.querySelector("a[download]").getAttribute("href"),
    "/uploads/report.pdf",
  );
});

const summary = {
  profile: { name: "验收", fields: [], interests: [], timeline: [] },
  posts: [],
  projects: [{ id: "p", title: "摘要中的项目", excerpt: "这是摘要" }],
  stories: [],
  surveys: [],
  questions: [],
};
const reply = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
const renderApp = async () => {
  dom.reconfigure({ url: "https://mumao.site/?page=notes&project=p" });
  sessionStorage.setItem("greeted", "1");
  root = createRoot(document.getElementById("app"));
  await act(() => root.render(React.createElement(App)));
};

test("independent detail waits for full content instead of rendering a card summary as the article", async () => {
  let resolveDetail;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === "/api/public?view=summary") return reply(summary);
    if (url === "/api/content/projects/p")
      return new Promise((resolve) => {
        resolveDetail = resolve;
      });
    throw new Error("unexpected request: " + url);
  };
  await renderApp();
  assert.ok(requests.includes("/api/public?view=summary"));
  assert.ok(requests.includes("/api/content/projects/p"));
  assert.match(document.querySelector("main").textContent, /正在读取完整内容/);
  assert.equal(document.querySelector("main article"), null);
  await act(async () => {
    resolveDetail(
      reply({ id: "p", title: "完整项目", body: "正文只从详情接口读取" }),
    );
  });
  assert.match(
    document.querySelector("main article").textContent,
    /正文只从详情接口读取/,
  );
  assert.equal(
    document.querySelector('[aria-current="page"]').textContent,
    "作品与项目",
  );
  assert.match(document.title, /完整项目/);
  await click(document.querySelector(".skip-main"));
  assert.equal(document.activeElement.id, "main-content");
});

test("failed detail requests are retryable and a missing/private article never shows server error details", async () => {
  let attempt = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/public?view=summary") return reply(summary);
    attempt++;
    return attempt === 1
      ? reply({ error: "网络暂时异常" }, 503)
      : reply({ title: "重试成功", body: "恢复的完整正文" });
  };
  await renderApp();
  assert.match(document.querySelector("main").textContent, /暂时无法读取内容/);
  await click(
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "重新读取",
    ),
  );
  assert.equal(attempt, 2);
  assert.match(
    document.querySelector("main article").textContent,
    /恢复的完整正文/,
  );
  await act(() => root.unmount());
  root = null;
  globalThis.fetch = async (url) =>
    url === "/api/public?view=summary"
      ? reply(summary)
      : reply({ error: "私密草稿的内部错误内容" }, 404);
  await renderApp();
  assert.match(
    document.querySelector("main").textContent,
    /这篇内容暂时不在这里/,
  );
  assert.doesNotMatch(
    document.querySelector("main").textContent,
    /私密草稿的内部错误内容/,
  );
});
