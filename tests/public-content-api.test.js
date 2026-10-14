import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

let child, directory, base, cookie;
async function request(path, body, method = "GET") {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie && path.startsWith("/api/admin") ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  return { response, data: await response.json() };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-v120-public-"));
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js", "--production"], { env: { ...process.env, PORT: String(port), DATA_DIR: directory, TEST_MODE: "1", ATLAS_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let errors = "";
    child.stderr.on("data", data => { errors += data.toString(); });
    child.stdout.on("data", data => { if (data.toString().includes("Personal Space:")) resolve(); });
    child.once("exit", code => reject(Error(`Fixture exit ${code}: ${errors}`)));
  });
  const setup = await request("/api/setup", { username: "qa", password: "isolated-public-test-password" }, "POST");
  assert.equal(setup.response.status, 200);
});
after(async () => {
  if (child && child.exitCode === null) { const ended = new Promise(resolve => child.once("exit", resolve)); child.kill(); await ended; }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("summary excludes full bodies, documents, attachments and drafts; detail only serves published articles", async () => {
  const body = "正文测试".repeat(10000);
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] };
  const created = await request("/api/admin/posts/new/draft", { revision: 0, title: "公开测试文章", body, content }, "PUT");
  assert.equal(created.response.status, 200);
  const record = created.data;
  assert.equal((await request(`/api/content/posts/${record.id}`)).response.status, 404);
  assert.equal((await request("/api/content/messages/any")).response.status, 404);
  const published = await request(`/api/admin/posts/${record.id}/publish`, { revision: record.revision }, "POST");
  assert.equal(published.response.status, 200);
  await request(`/api/admin/posts/${record.id}/draft`, { revision: published.data.revision, title: "不能公开的草稿标题", body: "不能公开的草稿正文", content: { type: "doc", content: [] } }, "PUT");
  const all = await request("/api/public?view=summary");
  const summary = all.data.posts.find(item => item.id === record.id);
  assert.equal(summary.title, "公开测试文章");
  assert.equal(summary.excerpt.length, 180);
  for (const field of ["body", "content", "draft", "attachments", "photoDetails"]) assert.equal(Object.hasOwn(summary, field), false);
  const detail = await request(`/api/content/posts/${record.id}`);
  assert.equal(detail.data.body, body);
  assert.equal(Object.hasOwn(detail.data, "draft"), false);
  const legacy = await request("/api/public");
  assert.equal(legacy.data.posts.find(item => item.id === record.id).body, body);
  const html = await (await fetch(`${base}/?page=about&post=${record.id}`)).text();
  assert.match(html, /<title>公开测试文章/);
  assert.doesNotMatch(html, /不能公开的草稿标题|不能公开的草稿正文/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /rel="canonical"/);
  const current = await request(`/api/admin/posts/${record.id}`);
  await request(`/api/admin/posts/${record.id}/unpublish`, { revision: current.data.revision }, "POST");
  assert.equal((await request(`/api/content/posts/${record.id}`)).response.status, 404);
  const hiddenHtml = await (await fetch(`${base}/?page=notes&post=${record.id}`)).text();
  assert.doesNotMatch(hiddenHtml, /公开测试文章|不能公开的草稿标题/);
});

test("anonymous detail and summary project only the confirmed public location", async () => {
  for (const precision of ["city", "hidden", "exact"]) {
    const created = await request("/api/admin/stories/new/draft", { revision: 0, title: `地点 ${precision}`, locationPrecision: precision, publicLocation: "可公开地点", location: "不能公开的原始详细地址", lat: 12.345678, lng: 98.765432, cityLat: 12, cityLng: 98, confirmLocation: true }, "PUT");
    assert.equal(created.response.status, 200);
    const result = await request(`/api/admin/stories/${created.data.id}/publish`, { revision: created.data.revision }, "POST");
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    const detail = (await request(`/api/content/stories/${created.data.id}`)).data;
    const summary = (await request("/api/public?view=summary")).data.stories.find(item => item.id === created.data.id);
    for (const item of [detail, summary]) {
      assert.doesNotMatch(JSON.stringify(item), /不能公开的原始详细地址/);
      assert.equal(item.location, "可公开地点");
      if (precision === "city") { assert.equal(item.lat, 12); assert.equal(item.lng, 98); }
      if (precision === "hidden") { assert.equal(Object.hasOwn(item, "lat"), false); assert.equal(Object.hasOwn(item, "cityLat"), false); }
      if (precision === "exact") assert.equal(item.lat, 12.345678);
    }
  }
});

test("PDF access follows live references through draft edits, shared projects and withdrawal", async () => {
  const pdf = "%PDF-1.4\n% isolated fixture\n%%EOF";
  const form = new FormData(); form.append("files", new Blob([pdf], { type: "application/pdf" }), "fixture.pdf");
  const uploaded = await fetch(base + "/api/admin/upload", { method: "POST", headers: { Cookie: cookie }, body: form });
  assert.equal(uploaded.status, 200);
  const file = (await uploaded.json()).files[0];
  const attachment = { src: file.url, name: "测试报告", size: file.size, version: "1", date: "2026-10-14" };
  assert.equal((await fetch(base + file.url)).status, 401);
  const project = (await request("/api/admin/projects/new/draft", { revision: 0, title: "附件项目", attachments: [attachment] }, "PUT")).data;
  assert.equal((await fetch(base + file.url)).status, 401);
  let current = (await request(`/api/admin/projects/${project.id}/publish`, { revision: project.revision }, "POST")).data;
  let media = await fetch(base + file.url);
  assert.equal(media.status, 200); assert.equal(await media.text(), pdf);
  assert.match(media.headers.get("cache-control"), /private, no-store/);
  assert.equal(media.headers.get("content-type"), "application/pdf");
  current = (await request(`/api/admin/projects/${project.id}/draft`, { revision: current.revision, attachments: [] }, "PUT")).data;
  assert.equal((await fetch(base + file.url)).status, 200, "editing a draft must not remove the live PDF");
  const shared = (await request("/api/admin/projects/new/draft", { revision: 0, title: "共享附件", attachments: [attachment] }, "PUT")).data;
  const liveShared = (await request(`/api/admin/projects/${shared.id}/publish`, { revision: shared.revision }, "POST")).data;
  await request(`/api/admin/projects/${project.id}/publish`, { revision: current.revision }, "POST");
  assert.equal((await fetch(base + file.url)).status, 200, "remaining public references keep a shared PDF public");
  await request(`/api/admin/projects/${shared.id}/unpublish`, { revision: liveShared.revision }, "POST");
  assert.equal((await fetch(base + file.url)).status, 401);
  const absent = await request("/api/admin/projects/new/draft", { revision: 0, title: "不存在的附件", attachments: [{ ...attachment, src: "/uploads/missing.pdf" }] }, "PUT");
  assert.equal(absent.response.status, 400);
});
