import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { editableContent, publicContent, publicationContent, validatePublication } from "../server/content.js";
import { validateContentMedia, prepareMedia, savePreparedMedia } from "../server/media-processing.js";
import { executeAdminRequest as run } from "../server/admin-cli.js";
import { renderPreview } from "../scripts/admin-preview.mjs";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const attachment = { src: "/uploads/paper.pdf", name: "说明文档.pdf", size: pdf.length, version: "v2", date: "2024-02-29" };
const privateStory = {
  title: "照片", locationPrecision: "city", location: "PRIVATE STREET SENTINEL", city: "PRIVATE CITY SENTINEL",
  publicLocation: "广州", lat: 23.123456, lng: 113.987654, cityLat: 23.1, cityLng: 113.3,
  photos: ["/uploads/photo.jpg"], photoDetails: [{ src: "/uploads/photo.jpg", alt: "照片", caption: "说明", takenAt: "2024-02-29", lat: 22.987654, lng: 114.123456 }],
  confirmLocation: true,
};
const normalize = (data, kind = "stories", base = {}, isNew = true) => editableContent(data, base, { kind, isNew });
const invalid = fn => assert.throws(fn, error => error.status === 400);
async function isolated(t, database = false) {
  const dir = await mkdtemp(join(tmpdir(), "personal-content-metadata-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "uploads"));
  if (database) {
    const db = new DatabaseSync(join(dir, "space.sqlite"));
    db.exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.close();
  }
  return dir;
}
const op = (view, action, data) => ({ action, kind: view.kind, id: view.id, expectedVersion: view.version,
  ...(data ? { data } : {}), ...(["publish", "unpublish"].includes(action) ? { target: view.target } : {}) });
async function approved(dir, operations, requestId) {
  const { preview } = await run(dir, { action: "preview", operations });
  return { action: "apply", operations, requestId, approved: true, previewToken: preview.token, previewExpiresAt: preview.expiresAt };
}

test("story public projection exposes deliberate city coordinates and never private metadata", () => {
  const live = publicContent({ ...privateStory, draft: { title: "PRIVATE DRAFT" }, revision: 5 }, "stories");
  assert.equal(live.location, "广州");
  assert.equal(live.lat, 23.1); assert.equal(live.lng, 113.3);
  const json = JSON.stringify(live);
  for (const sentinel of ["PRIVATE", "23.123456", "113.987654", "22.987654", "114.123456", "cityLat", "cityLng", "confirmLocation", "revision"])
    assert.ok(!json.includes(sentinel), sentinel);
  assert.deepEqual(live.photos, privateStory.photos);
  assert.equal(live.photoDetails[0].takenAt, "2024-02-29");
  const hidden = publicContent({ ...privateStory, locationPrecision: "hidden", publicLocation: "某个地方" }, "stories");
  assert.equal(hidden.location, "某个地方");
  for (const key of ["lat", "lng", "cityLat", "cityLng", "city"]) assert.equal(hidden[key], undefined);
  const unnamed = publicContent({ ...privateStory, publicLocation: undefined }, "stories");
  assert.equal(unnamed.location, undefined);
  const exact = publicContent({ ...privateStory, locationPrecision: "exact" }, "stories");
  assert.equal(exact.lat, privateStory.lat); assert.equal(exact.location, "广州");
  assert.equal(exact.photoDetails[0].lat, undefined);
});

test("legacy stories retain existing exact publication while all new backend drafts default city", () => {
  const legacy = { title: "旧照片", location: "旧地点", city: "旧城市", lat: 0, lng: 0 };
  assert.equal(normalize({}, "stories", legacy, false).locationPrecision, undefined);
  assert.deepEqual(publicContent(legacy, "stories"), legacy);
  assert.equal(normalize({}, "stories").locationPrecision, "city");
  const legacyAlbum = { ...legacy, photos: ["https://legacy.example/photo.jpg"] };
  assert.deepEqual(normalize({}, "stories", legacyAlbum, false).photos, legacyAlbum.photos);
  invalid(() => validatePublication("stories", normalize({ title: "新建", lat: 0, lng: 0, confirmLocation: true })));
  assert.doesNotThrow(() => validatePublication("stories", normalize({ title: "不公开", locationPrecision: "hidden" })));
  assert.doesNotThrow(() => validatePublication("stories", normalize({ ...privateStory, cityLat: 0, cityLng: 0 })));
  invalid(() => validatePublication("stories", normalize({ ...privateStory, publicLocation: " " })));
  invalid(() => validatePublication("stories", normalize({ ...privateStory, confirmLocation: false })));
  assert.equal(normalize({ cityLat: 22 }, "stories", privateStory, false).confirmLocation, false);
  assert.equal(normalize({ lat: "", lng: null }, "stories", privateStory, false).lat, null);
});

test("photos, coordinates, dates and PDF metadata reject malformed or unbounded inputs", () => {
  for (const data of [
    { locationPrecision: "street" }, { dateMode: "today" }, { lat: 91 }, { lng: -181 }, { lat: true }, { cityLat: " " },
    { date: "2023-02-29" }, { date: "2024-04-31" }, { date: "2024-01-01T00:00:00Z" }, { date: "0000-01-01" },
    { photos: ["/uploads/a.jpg", "/uploads/a.jpg"] }, { photos: ["https://other.test/a.jpg"] }, { photos: ["/uploads/../a.jpg"] },
    { photos: ["/uploads/a.jpg"], photoDetails: [{ src: "/uploads/a.jpg", takenAt: "2023-02-29" }] },
    { photos: ["/uploads/a.jpg"], photoDetails: [{ src: "/uploads/a.jpg", lat: 91 }] },
    { photos: ["/uploads/a.jpg"], photoDetails: [{ src: "/uploads/a.jpg", token: "no" }] },
    { photoDetails: [{ src: "/uploads/missing.jpg" }] },
  ]) invalid(() => normalize(data));
  assert.equal(normalize({ date: "2024-02-29" }, "posts").dateMode, "manual");
  const valid = normalize({ attachments: [attachment] }, "projects");
  assert.deepEqual(valid.attachments, [attachment]);
  for (const changed of [{ src: "https://mumao.site/uploads/paper.pdf" }, { src: "/uploads/a.pdf?q=1" },
    { src: "/uploads/a.jpg" }, { size: pdf.length + 0.5 }, { size: 0 }, { size: 15 * 1024 * 1024 + 1 },
    { name: "" }, { version: "x".repeat(101) }, { date: "2026-02-30" }, { token: "no" }])
    invalid(() => normalize({ attachments: [{ ...attachment, ...changed }] }, "projects"));
  invalid(() => normalize({ attachments: [attachment, attachment] }, "projects"));
  invalid(() => normalize({ attachments: [attachment] }, "posts"));
});

test("publication dates use Shanghai first publication and never guess photo dates", () => {
  const fresh = normalize({ title: "文章", date: "" }, "posts");
  assert.equal(fresh.dateMode, "auto"); assert.equal(fresh.date, "");
  const first = publicationContent("posts", fresh, {}, "2026-10-14T16:01:00Z");
  assert.equal(first.date, "2026-10-15");
  assert.equal(publicationContent("posts", fresh, { ...first, publishedAt: "2026-10-14T16:01:00Z" }, "2027-01-01T00:00:00Z").date, first.date);
  assert.equal(publicationContent("posts", fresh, { dateMode: "manual", date: "2020-01-01", publishedAt: "2026-10-14T16:01:00Z" }).date, "2026-10-15");
  assert.equal(publicationContent("posts", fresh, { published: true }).date, "");
  const manual = normalize({ date: "2024-02-29", dateMode: "manual" }, "posts");
  assert.equal(publicationContent("posts", manual).date, "2024-02-29");
  assert.equal(publicationContent("posts", { date: "2022-01-01" }).date, "2022-01-01");
  assert.equal(publicationContent("stories", { date: "", dateMode: "auto" }, { createdAt: "2026-01-01T00:00:00Z" }).date, "");
  assert.equal(normalize({ date: "2022-02-03" }, "posts", { dateMode: "auto", date: "2022-01-01" }, false).dateMode, "manual");
});

test("PDF reference checks use actual bytes and size, never arbitrary files or symlinked directories", async t => {
  const dir = await isolated(t);
  await writeFile(join(dir, "uploads", "paper.pdf"), pdf);
  assert.doesNotThrow(() => validateContentMedia(dir, "projects", { attachments: [attachment] }));
  invalid(() => validateContentMedia(dir, "projects", { attachments: [{ ...attachment, size: 1 }] }));
  invalid(() => validateContentMedia(dir, "projects", { attachments: [{ ...attachment, src: "/uploads/absent.pdf" }] }));
  await writeFile(join(dir, "uploads", "paper.pdf"), Buffer.alloc(pdf.length));
  invalid(() => validateContentMedia(dir, "projects", { attachments: [attachment] }));
  const second = await isolated(t); await rm(join(second, "uploads"), { recursive: true });
  await symlink(join(dir, "uploads"), join(second, "uploads"), process.platform === "win32" ? "junction" : "dir");
  invalid(() => validateContentMedia(second, "projects", { attachments: [attachment] }));
});

test("uploaded PDFs expose actual metadata and assistant batches rollback if an attachment disappears", async t => {
  const dir = await isolated(t, true);
  const saved = await savePreparedMedia(dir, await prepareMedia([{ name: "文档.pdf", buffer: pdf }]));
  assert.equal(saved.files[0].size, pdf.length); assert.equal(saved.files[0].type, "application/pdf");
  const operations = [{ action: "create", kind: "posts", data: { title: "不会留下的文章" } },
    { action: "create", kind: "projects", data: { title: "文档项目", attachments: [{ ...attachment, src: saved.files[0].url }] } }];
  const request = await approved(dir, operations, "attachment-batch-001");
  await saved.rollback();
  await assert.rejects(run(dir, request), error => error.status === 400);
  const db = new DatabaseSync(join(dir, "space.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records").get().n, 0); db.close();
});

test("assistant publication preview date is invalidated across Shanghai midnight", async t => {
  const dir = await isolated(t, true);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-14T15:59:00Z") });
  const { results: [draft] } = await run(dir, { action: "apply", requestId: "midnight-create-001", operations: [{ action: "create", kind: "posts", data: { title: "跨日文章" } }] });
  const request = await approved(dir, [op(draft, "publish")], "midnight-publish-001");
  t.mock.timers.setTime(new Date("2026-10-14T16:01:00Z").getTime());
  await assert.rejects(run(dir, request), error => error.code === "PREVIEW_CONFLICT");
  const retry = await approved(dir, [op(draft, "publish")], "midnight-publish-001");
  const { results: [published] } = await run(dir, retry);
  assert.equal(published.live.date, "2026-10-15");
  assert.equal((await run(dir, retry)).replayed, true);
});

test("assistant photo metadata saves privately, changes version and requires fresh preview after concurrent edits", async t => {
  const dir = await isolated(t, true);
  const create = { action: "apply", requestId: "photo-metadata-001", operations: [{ action: "create", kind: "stories", data: privateStory }] };
  const { results: [draft] } = await run(dir, create);
  assert.equal(draft.published, false); assert.equal(draft.draft.photoDetails[0].lat, privateStory.photoDetails[0].lat);
  assert.equal((await run(dir, create)).results[0].id, draft.id);
  const request = await approved(dir, [op(draft, "publish")], "photo-publish-001");
  const { results: [changed] } = await run(dir, { action: "apply", requestId: "photo-update-001", operations: [op(draft, "update", { photoDetails: [{ ...privateStory.photoDetails[0], caption: "修改后的说明" }] })] });
  assert.notEqual(changed.version, draft.version);
  await assert.rejects(run(dir, request), error => error.status === 409);
  const publication = await approved(dir, [op(changed, "publish")], "photo-publish-001");
  const { results: [live] } = await run(dir, publication);
  assert.equal(live.live.photoDetails[0].caption, "修改后的说明");
  assert.equal(live.live.photoDetails[0].lat, privateStory.photoDetails[0].lat);
  assert.equal(publicContent(live.live, "stories").photoDetails[0].lat, undefined);
  assert.equal((await run(dir, publication)).replayed, true);
  await assert.rejects(run(dir, { action: "apply", requestId: "photo-invalid-001", operations: [op(live, "update", { photoDetails: [{ ...privateStory.photoDetails[0], shell: "no" }] })] }), error => error.status === 400);
});

test("legacy publication without a timestamp keeps its historical authored date", async t => {
  const dir = await isolated(t, true);
  const db = new DatabaseSync(join(dir, "space.sqlite"));
  db.prepare("INSERT INTO records VALUES(?,?,?)").run("posts", "legacy", JSON.stringify({ id: "legacy", title: "旧文章", date: "2020-01-01", published: true, revision: 1 }));
  db.close();
  const { item } = await run(dir, { action: "get", kind: "posts", id: "legacy" });
  const request = await approved(dir, [op(item, "publish")], "legacy-publish-001");
  const { results: [live] } = await run(dir, request);
  assert.equal(live.live.date, "2020-01-01");
  const check = new DatabaseSync(join(dir, "space.sqlite"));
  const stored = JSON.parse(check.prepare("SELECT body FROM records WHERE id='legacy'").get().body);
  check.close();
  assert.equal(stored.publishedAt, undefined);
});

test("assistant previews separate private GPS from public content and show photo/PDF details", () => {
  const dom = new JSDOM(renderPreview({ items: [{ kind: "stories", action: "update", draft: privateStory }] }));
  const publicText = dom.window.document.querySelector(".public-article").textContent;
  assert.ok(publicText.includes("广州")); assert.ok(publicText.includes("2024-02-29"));
  assert.ok(!publicText.includes("PRIVATE")); assert.ok(!publicText.includes("23.123456"));
  assert.ok(dom.window.document.querySelector(".private-metadata").textContent.includes("PRIVATE STREET"));
  const html = renderPreview({ items: [{ kind: "projects", draft: { title: "PDF项目", attachments: [attachment] } }] }, { "paper.pdf": "media/paper.pdf" });
  assert.ok(html.includes('href="media/paper.pdf"')); assert.ok(html.includes("说明文档.pdf")); assert.ok(html.includes("v2"));
});
