import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import sharp from "sharp";
import { editableContent } from "../server/content.js";
import {
  exifDate,
  readPhotoMetadata,
  storyPublicationProblem,
  validCoordinates,
} from "../src/media-workbench-state.js";

let dom,
  vite,
  root,
  createRoot,
  PhotoWorkbench,
  ProjectAttachments,
  StoryLocationFields,
  container;
const originalFetch = globalThis.fetch,
  originalCreate = URL.createObjectURL,
  originalRevoke = URL.revokeObjectURL;
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
    "FormData",
    "File",
    "MutationObserver",
    "getComputedStyle",
  ]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  }
  URL.createObjectURL = (file) =>
    `blob:local-test/${encodeURIComponent(file.name)}`;
  URL.revokeObjectURL = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ PhotoWorkbench, ProjectAttachments } = await vite.ssrLoadModule(
    "/src/media-workbench.jsx",
  ));
  ({ default: StoryLocationFields } = await vite.ssrLoadModule(
    "/src/story-location-fields.jsx",
  ));
});

test("real synthetic JPEG EXIF yields the authored calendar date and GPS while plain images stay unknown", async () => {
  const jpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "red" },
  })
    .jpeg()
    .withExifMerge({
      IFD2: { DateTimeOriginal: "2026:10:11 23:20:00" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "20/1 30/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "110/1 15/1 0/1",
      },
    })
    .toBuffer();
  assert.deepEqual(await readPhotoMetadata(jpeg), {
    takenAt: "2026-10-11",
    lat: 20.5,
    lng: 110.25,
  });
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  assert.deepEqual(await readPhotoMetadata(png), { takenAt: "" });
});

test("individual upload progress remains visible until the server accepts the attachment", async () => {
  const upload = deferred();
  const state = await render(
    ProjectAttachments,
    { attachments: [] },
    {
      uploader: (_file, progress) => {
        progress(42);
        return upload.promise;
      },
    },
  );
  await choose([pdf("progress.pdf")]);
  await click("上传已选择的附件");
  assert.equal(container.querySelector("progress").value, 42);
  assert.equal(state.blocked, true);
  assert.deepEqual(state.value.attachments, []);
  await act(async () =>
    upload.resolve({ url: "/uploads/progress.pdf", size: 42 }),
  );
  assert.equal(container.querySelector("progress"), null);
  assert.equal(state.blocked, false);
});

test("normal article draft payload does not accidentally include project-only attachments", async () => {
  const { ContentEditor } = await vite.ssrLoadModule("/src/admin.jsx");
  let captured;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/admin/posts/new/draft");
    const body = JSON.parse(options.body);
    captured = editableContent(body, {}, { kind: "posts", isNew: true });
    return {
      ok: true,
      json: async () => ({
        id: "new-draft",
        revision: 1,
        published: false,
        draft: captured,
      }),
    };
  };
  container = document.getElementById("test");
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(ContentEditor, {
        kind: "posts",
        item: { id: "new", title: "New essay", body: "Draft" },
        leaveEditor: { current: null },
        close: () => {},
        save: async () => {},
      }),
    ),
  );
  await click("保存草稿");
  assert.equal(captured.title, "New essay");
  assert.equal(captured.date, "");
  assert.equal(captured.dateMode, "auto");
  assert.equal(captured.attachments, undefined);
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  // Tiptap schedules its final DOM teardown after React unmount.
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const photo = (name) => new File(["local-image"], name, { type: "image/jpeg" });
const pdf = (name) =>
  new File(["%PDF-1.4 local fixture"], name, { type: "application/pdf" });
const button = (text) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
async function click(text) {
  const element = button(text);
  assert.ok(element, `missing button: ${text}`);
  await act(async () => element.click());
}
async function choose(files) {
  const input = container.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
}
async function input(label, value) {
  const element = [...container.querySelectorAll("label")]
    .find((node) => node.firstChild?.textContent === label)
    ?.querySelector("input");
  assert.ok(element, `missing field ${label}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function render(Component, initial, props = {}) {
  const state = { value: initial, blocked: false };
  function Harness() {
    const [value, setValue] = useState(initial);
    state.value = value;
    state.change = setValue;
    return React.createElement(Component, {
      value,
      onChange: setValue,
      onBlockedChange: (blocked) => {
        state.blocked = blocked;
      },
      ...props,
    });
  }
  container = document.getElementById("test");
  root = createRoot(container);
  await act(async () => root.render(React.createElement(Harness)));
  return state;
}

test("photo selection shows local thumbnails and EXIF before upload without applying GPS or sending location", async () => {
  let uploads = 0,
    fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw Error("unexpected network");
  };
  const state = await render(
    PhotoWorkbench,
    {
      photos: [],
      photoDetails: [],
      lat: 10,
      lng: 20,
      date: "",
      dateMode: "auto",
    },
    {
      isNew: true,
      metadataReader: async () => ({
        takenAt: "2026-10-11",
        lat: 23,
        lng: 113,
      }),
      uploader: async () => {
        uploads++;
      },
    },
  );
  await choose([photo("photo.jpg")]);
  assert.match(container.querySelector("img").src, /^blob:local-test/);
  assert.match(container.textContent, /2026-10-11/);
  assert.equal(uploads, 0);
  assert.equal(fetches, 0);
  assert.equal(state.blocked, true);
  assert.equal(state.value.lat, 10);
  assert.equal(state.value.date, "");
});

test("chosen GPS applies only after successful upload and a failed attempt preserves original coordinates and manual date", async () => {
  const first = deferred();
  let attempt = 0;
  const state = await render(
    PhotoWorkbench,
    {
      photos: [],
      photoDetails: [],
      lat: 10,
      lng: 20,
      date: "2020-02-03",
      dateMode: "manual",
      confirmLocation: true,
    },
    {
      isNew: true,
      metadataReader: async () => ({
        takenAt: "2026-10-11",
        lat: 23,
        lng: 113,
      }),
      uploader: async () =>
        ++attempt === 1 ? first.promise : { url: "/uploads/safe.jpg" },
    },
  );
  await choose([photo("photo.jpg")]);
  await act(async () => container.querySelector('input[type="radio"]').click());
  await click("上传已选择的照片");
  await act(async () => first.reject(Error("网络中断")));
  assert.equal(state.value.lat, 10);
  assert.equal(state.value.lng, 20);
  assert.deepEqual(state.value.photos, []);
  assert.equal(state.blocked, true);
  await click("重试上传");
  assert.equal(state.value.lat, 23);
  assert.equal(state.value.lng, 113);
  assert.equal(state.value.confirmLocation, false);
  assert.equal(state.value.date, "2020-02-03");
  assert.equal(state.value.photoDetails[0].takenAt, "2026-10-11");
  assert.equal(state.blocked, false);
});

test("same-day photos fill only a new empty automatic date; mixed dates require selection and additions preserve the original date", async () => {
  const state = await render(
    PhotoWorkbench,
    { photos: [], photoDetails: [], date: "", dateMode: "auto" },
    {
      isNew: true,
      metadataReader: async (file) => ({
        takenAt: file.name.startsWith("old") ? "2020-01-02" : "2026-10-11",
      }),
      uploader: async (file) => ({ url: `/uploads/${file.name}` }),
    },
  );
  await choose([photo("a.jpg"), photo("b.jpg")]);
  await click("上传已选择的照片");
  assert.equal(state.value.date, "2026-10-11");
  await choose([photo("old.jpg")]);
  await click("上传已选择的照片");
  assert.equal(state.value.date, "2026-10-11");
  await click("2020-01-02");
  assert.equal(state.value.date, "2020-01-02");
  assert.equal(state.value.dateMode, "manual");
  await click("设为封面");
  assert.equal(state.value.cover, "/uploads/a.jpg");
  await act(async () =>
    container.querySelector('button[aria-label="照片下移"]').click(),
  );
  assert.deepEqual(state.value.photos, [
    "/uploads/b.jpg",
    "/uploads/a.jpg",
    "/uploads/old.jpg",
  ]);
});

test("mixed or unknown EXIF dates do not invent a story date", async () => {
  const state = await render(
    PhotoWorkbench,
    { photos: [], photoDetails: [], date: "", dateMode: "auto" },
    {
      isNew: true,
      metadataReader: async (file) =>
        file.name === "unknown.jpg"
          ? {}
          : { takenAt: file.name === "a.jpg" ? "2026-10-10" : "2026-10-11" },
      uploader: async (file) => ({ url: `/uploads/${file.name}` }),
    },
  );
  await choose([photo("a.jpg"), photo("b.jpg"), photo("unknown.jpg")]);
  await click("上传已选择的照片");
  assert.equal(state.value.date, "");
  assert.match(container.textContent, /照片跨越多个日期/);
});

test("removing an in-flight photo prevents a late upload response from reappearing or applying GPS", async () => {
  const upload = deferred();
  const state = await render(
    PhotoWorkbench,
    { photos: [], photoDetails: [], date: "", lat: "", lng: "" },
    {
      isNew: true,
      metadataReader: async () => ({ lat: 23, lng: 113 }),
      uploader: () => upload.promise,
    },
  );
  await choose([photo("a.jpg")]);
  await act(async () => container.querySelector('input[type="radio"]').click());
  await click("上传已选择的照片");
  await click("移除此待上传文件");
  await act(async () => upload.resolve({ url: "/uploads/late.jpg" }));
  assert.deepEqual(state.value.photos, []);
  assert.equal(state.value.lat, "");
  assert.equal(state.blocked, false);
});

test("PDF attachments keep visible name/version/date, authoritative size, order and retry state", async () => {
  let attempts = 0;
  const state = await render(
    ProjectAttachments,
    { attachments: [] },
    {
      uploader: async (file) => {
        if (++attempts === 1) throw Error("上传中断");
        return { url: `/uploads/${file.name}`, size: 42 };
      },
    },
  );
  await choose([pdf("report.pdf")]);
  await input("附件显示名称", "研究报告");
  await input("附件版本", "v2");
  await input("附件日期", "2026-10-11");
  await click("上传已选择的附件");
  assert.equal(state.blocked, true);
  assert.deepEqual(state.value.attachments, []);
  await click("重试上传");
  assert.deepEqual(state.value.attachments, [
    {
      src: "/uploads/report.pdf",
      name: "研究报告",
      version: "v2",
      date: "2026-10-11",
      size: 42,
    },
  ]);
  await choose([pdf("appendix.pdf")]);
  await click("上传已选择的附件");
  await act(async () =>
    container.querySelector('button[aria-label="附件下移"]').click(),
  );
  assert.equal(state.value.attachments[0].src, "/uploads/appendix.pdf");
  await click("移除附件");
  assert.equal(state.value.attachments.length, 1);
  assert.equal(state.blocked, false);
});

test("GPS changes never auto-geocode; explicit reverse query returns a candidate without publishing it automatically", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({ city: "广州", cityLat: 23.1, cityLng: 113.3 }),
    };
  };
  const state = await render(StoryLocationFields, {
    lat: 23,
    lng: 113,
    locationPrecision: "city",
    cityLat: "",
    cityLng: "",
    publicLocation: "",
  });
  await act(async () =>
    state.change((previous) => ({ ...previous, lat: 24, lng: 114 })),
  );
  assert.equal(requests.length, 0);
  await click("向 Nominatim 发送精确坐标并查询附近城市");
  assert.equal(requests.length, 1);
  assert.match(requests[0], /lat=24&lng=114/);
  assert.equal(state.value.cityLat, "");
  await click("明确采用这个公开城市与代表点");
  assert.equal(state.value.publicLocation, "广州");
  assert.equal(state.value.cityLat, 23.1);
  assert.equal(state.value.lat, 24);
});

test("a delayed geocoder response cannot replace subsequently edited coordinates", async () => {
  const response = deferred();
  globalThis.fetch = () => response.promise;
  const state = await render(StoryLocationFields, {
    lat: 23,
    lng: 113,
    locationPrecision: "city",
  });
  await click("向 Nominatim 发送精确坐标并查询附近城市");
  await act(async () => state.change((previous) => ({ ...previous, lat: 25 })));
  await act(async () =>
    response.resolve({
      ok: true,
      json: async () => ({ city: "旧候选", cityLat: 23, cityLng: 113 }),
    }),
  );
  assert.doesNotMatch(container.textContent, /城市候选：旧候选/);
  assert.equal(state.value.lat, 25);
});

test("missing geocoder coordinates cannot become a fabricated zero point or replace the public city point", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { display_name: "无坐标候选", lat: null, lon: "", name: "城市候选" },
    ],
  });
  const state = await render(StoryLocationFields, {
    lat: 23.12345,
    lng: 113.54321,
    cityLat: 23,
    cityLng: 113,
    publicLocation: "既有城市",
    locationPrecision: "city",
  });
  await input("搜索地址或城市", "城市");
  await click("向 Nominatim 查询此文字");
  await click("设为公开城市代表点：无坐标候选");
  assert.equal(state.value.cityLat, 23);
  assert.equal(state.value.cityLng, 113);
  assert.equal(state.value.publicLocation, "既有城市");
  assert.match(container.textContent, /候选地点没有有效坐标/);
  for (const value of [null, undefined, "", "   ", false, true])
    assert.equal(validCoordinates(value, value), false);
  assert.equal(validCoordinates(0, 0), true);
});

test("publication checks respect exact/city/hidden and EXIF dates reject invalid calendar values", () => {
  assert.match(
    storyPublicationProblem({
      locationPrecision: "city",
      lat: 23,
      lng: 113,
      publicLocation: "广州",
      confirmLocation: true,
    }),
    /城市代表点/,
  );
  assert.equal(
    storyPublicationProblem({
      locationPrecision: "city",
      cityLat: 23,
      cityLng: 113,
      publicLocation: "广州",
      confirmLocation: true,
    }),
    "",
  );
  assert.equal(storyPublicationProblem({ locationPrecision: "hidden" }), "");
  assert.match(storyPublicationProblem({ lat: 23, lng: 113 }), /确认/);
  assert.equal(exifDate("2024:02:29 12:30:00"), "2024-02-29");
  assert.equal(exifDate("2025:02:29 12:30:00"), "");
  assert.equal(exifDate(undefined), "");
});

test("pending project attachments disable publishing and removal restores it without sending a publish request", async () => {
  const { ContentEditor } = await vite.ssrLoadModule("/src/admin.jsx");
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    throw Error("No writes expected");
  };
  container = document.getElementById("test");
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(ContentEditor, {
        kind: "projects",
        item: { id: "new", title: "Project", body: "Draft" },
        leaveEditor: { current: null },
        close: () => {},
        save: async () => {},
      }),
    ),
  );
  const input = container.querySelector('input[accept="application/pdf,.pdf"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [pdf("report.pdf")],
  });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
  assert.equal(button("发布文章").disabled, true);
  await act(async () =>
    container
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.deepEqual(requests, []);
  await click("移除此待上传文件");
  assert.equal(button("发布文章").disabled, false);
});
