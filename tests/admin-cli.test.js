import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { executeAdminRequest as run } from "../server/admin-cli.js";

const directories = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "personal-admin-cli-"));
  directories.push(dir);
  const db = new DatabaseSync(join(dir, "space.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO records VALUES (?,?,?)").run(
    "posts",
    "one",
    JSON.stringify({
      id: "one",
      title: "Published original",
      body: "Original",
      published: true,
      revision: 1,
    }),
  );
  db.prepare("INSERT INTO records VALUES (?,?,?)").run(
    "messages",
    "private",
    JSON.stringify({
      id: "private",
      email: "PRIVATE_VISITOR",
      question: "PRIVATE_MESSAGE",
    }),
  );
  db.prepare("INSERT INTO records VALUES (?,?,?)").run(
    "submissions",
    "response",
    JSON.stringify({ id: "response", answers: "PRIVATE_RESPONSE" }),
  );
  db.prepare("INSERT INTO settings VALUES (?,?)").run(
    "profile",
    JSON.stringify({
      name: "Owner",
      email: "",
      phone: "",
      wechat: "",
      github: "",
      intro: "Keep intro",
      bio: "Keep bio",
      portrait: "",
      interests: [],
      timeline: [],
      acceptQuestions: true,
      revision: 1,
    }),
  );
  db.prepare("INSERT INTO settings VALUES (?,?)").run(
    "notifications",
    JSON.stringify({ secret: "PRIVATE_KEY" }),
  );
  db.close();
  return dir;
}
after(async () => {
  for (const dir of directories)
    await rm(dir, { recursive: true, force: true });
});
function state(dir) {
  const db = new DatabaseSync(join(dir, "space.sqlite"), { readOnly: true });
  try {
    return JSON.stringify({
      records: db.prepare("SELECT * FROM records ORDER BY kind,id").all(),
      settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
    });
  } finally {
    db.close();
  }
}
const get = async (dir, kind = "posts", id = "one") =>
  (await run(dir, { action: "get", kind, id })).item;
const update = (view, data) => ({
  action: "update",
  kind: view.kind,
  id: view.id,
  expectedVersion: view.version,
  data,
});
const apply = (dir, operation, requestId = "test-request-001") =>
  run(dir, { action: "apply", requestId, operations: [operation] });
async function approve(dir, operations, requestId = "test-approved-001") {
  const { preview } = await run(dir, { action: "preview", operations });
  return {
    action: "apply",
    requestId,
    operations,
    approved: true,
    previewToken: preview.token,
    previewExpiresAt: preview.expiresAt,
  };
}
function child(dir, request) {
  return new Promise((resolvePromise, reject) => {
    const processChild = spawn(process.execPath, ["server/admin-cli.js"], {
      env: { ...process.env, DATA_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    processChild.stdout.on("data", (data) => (output += data));
    processChild.on("error", reject);
    processChild.on("close", (code) => {
      try {
        resolvePromise({ code, ...JSON.parse(output) });
      } catch (error) {
        reject(error);
      }
    });
    processChild.stdin.end(
      typeof request === "string" ? request : JSON.stringify(request),
    );
  });
}

test("assistant queries do not expose visitor data or initialize missing databases", async () => {
  const dir = await fixture(),
    original = state(dir);
  const result = await run(dir, { action: "list", kind: "posts" });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].title, "Published original");
  assert.equal(result.items[0].draft, undefined);
  assert.equal(result.items[0].live, undefined);
  assert.doesNotMatch(JSON.stringify(await get(dir)), /PRIVATE_/);
  for (const kind of [
    "messages",
    "submissions",
    "outbox",
    "settings",
    "assistant_receipts",
    "../../settings",
  ])
    await assert.rejects(run(dir, { action: "list", kind }), { status: 400 });
  await assert.rejects(
    run(join(dir, "missing"), { action: "list", kind: "posts" }),
    { status: 404 },
  );
  assert.equal(state(dir), original);
});
test("assistant rejects invalid parameters, command injection and malformed JSON", async () => {
  const dir = await fixture(),
    original = state(dir);
  for (const request of [
    { action: "sql", query: "DELETE FROM records" },
    { action: "list", kind: "posts", command: "whoami" },
    { action: "list", kind: "posts", limit: 101 },
    { action: "get", kind: "posts", id: "one;rm -rf /" },
    { action: "apply", requestId: "short", operations: [] },
    {
      action: "apply",
      requestId: "valid-id-001",
      operations: [{ action: "delete", kind: "posts", id: "one" }],
    },
  ])
    await assert.rejects(run(dir, request), { status: 400 });
  const malformed = await child(dir, "{broken");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 400);
  for (const raw of ["null", "[]", '{"action":{"toString":null}}'])
    assert.equal((await child(dir, raw)).status, 400);
  assert.equal(state(dir), original);
});
test("single default draft creation is idempotent and receipt fingerprints reject reuse", async () => {
  const dir = await fixture(),
    operation = {
      action: "create",
      kind: "posts",
      data: { title: "New draft", body: "Text" },
    };
  const first = await apply(dir, operation),
    repeat = await apply(dir, operation);
  assert.equal(repeat.replayed, true);
  assert.equal(repeat.results[0].id, first.results[0].id);
  assert.equal(first.results[0].published, false);
  assert.equal(first.results[0].draft.title, "New draft");
  assert.equal((await run(dir, { action: "list", kind: "posts" })).total, 2);
  await assert.rejects(
    apply(dir, { ...operation, data: { title: "Different" } }),
    { status: 409 },
  );
});
test("draft saves retain published content and require current version", async () => {
  const dir = await fixture(),
    original = await get(dir),
    operation = update(original, {
      title: "Pending title",
      body: "Pending text",
    });
  await apply(dir, operation);
  const current = await get(dir);
  assert.equal(current.live.title, "Published original");
  assert.equal(current.draft.title, "Pending title");
  await assert.rejects(apply(dir, operation, "different-request-002"), {
    status: 409,
  });
});
test("preview is read-only and publication requires approval bound to content and target", async () => {
  const dir = await fixture();
  await apply(dir, update(await get(dir), { title: "Ready draft" }));
  const item = await get(dir),
    op = {
      action: "publish",
      kind: "posts",
      id: item.id,
      expectedVersion: item.version,
      target: item.target,
    };
  const before = state(dir),
    request = await approve(dir, [op]);
  assert.equal(state(dir), before);
  const { preview } = await run(dir, { action: "preview", operations: [op] });
  assert.equal(preview.items[0].live.title, "Published original");
  assert.equal(preview.items[0].draft.title, "Ready draft");
  assert.equal(preview.items[0].version, item.version);
  assert.ok(preview.items[0].changes.includes("title"));
  await assert.rejects(run(dir, { ...request, approved: false }), {
    code: "APPROVAL_REQUIRED",
  });
  await assert.rejects(run(dir, { ...request, previewToken: "0".repeat(64) }), {
    code: "PREVIEW_CONFLICT",
  });
  await assert.rejects(
    run(dir, {
      ...request,
      operations: [{ ...op, target: "https://elsewhere.example/" }],
    }),
    { status: 409 },
  );
  const result = await run(dir, request);
  assert.equal(result.results[0].published, true);
  assert.equal(result.results[0].live.title, "Ready draft");
  assert.equal(result.results[0].target, "https://mumao.site/?post=one");
  assert.equal((await run(dir, request)).replayed, true);
});
test("expired and stale previews fail without overwriting later drafts", async () => {
  const dir = await fixture();
  await apply(dir, update(await get(dir), { title: "Ready" }));
  const item = await get(dir),
    request = await approve(dir, [
      {
        action: "publish",
        kind: "posts",
        id: "one",
        expectedVersion: item.version,
        target: item.target,
      },
    ]);
  await assert.rejects(
    run(dir, { ...request, previewExpiresAt: "2000-01-01T00:00:00.000Z" }),
    { code: "PREVIEW_CONFLICT" },
  );
  await apply(dir, update(item, { title: "Newer work" }), "newer-request-003");
  await assert.rejects(run(dir, request), { status: 409 });
  assert.equal((await get(dir)).draft.title, "Newer work");
  assert.equal((await get(dir)).live.title, "Published original");
});
test("withdrawal preview shows the actual live content and keeps pending drafts", async () => {
  const dir = await fixture();
  await apply(dir, update(await get(dir), { title: "Not published yet" }));
  const item = await get(dir),
    operations = [
      {
        action: "unpublish",
        kind: "posts",
        id: item.id,
        expectedVersion: item.version,
        target: item.target,
      },
    ];
  const { preview } = await run(dir, { action: "preview", operations });
  assert.equal(preview.items[0].draft.title, "Published original");
  const request = await approve(dir, operations, "withdraw-request-001");
  await run(dir, request);
  const current = await get(dir);
  assert.equal(current.published, false);
  assert.equal(current.draft.title, "Not published yet");
});
test("batch preview and apply are atomic with impact count and idempotent replay", async () => {
  const dir = await fixture(),
    operations = [
      { action: "create", kind: "posts", data: { title: "A" } },
      { action: "create", kind: "projects", data: { title: "B" } },
    ];
  const before = state(dir),
    preview = await run(dir, { action: "preview", operations });
  assert.equal(preview.preview.impactCount, 2);
  assert.equal(state(dir), before);
  await assert.rejects(
    run(dir, { action: "apply", requestId: "batch-request-001", operations }),
    { code: "APPROVAL_REQUIRED" },
  );
  const request = await approve(dir, operations, "batch-request-001"),
    result = await run(dir, request);
  assert.equal(result.results.length, 2);
  assert.equal((await run(dir, request)).replayed, true);
  assert.equal((await run(dir, { action: "list", kind: "posts" })).total, 2);
});
test("invalid batch and duplicate target reject without data or receipt writes", async () => {
  const dir = await fixture(),
    before = state(dir),
    item = await get(dir);
  const bad = [
    { action: "create", kind: "posts", data: { title: "Would write" } },
    { action: "create", kind: "projects", data: { title: 42 } },
  ];
  await assert.rejects(run(dir, { action: "preview", operations: bad }));
  assert.equal(state(dir), before);
  await assert.rejects(
    run(dir, {
      action: "preview",
      operations: [update(item, { title: "A" }), update(item, { title: "B" })],
    }),
    { status: 400 },
  );
  await assert.rejects(
    run(dir, {
      action: "preview",
      operations: Array.from({ length: 21 }, () => bad[0]),
    }),
    { status: 400 },
  );
  assert.equal(state(dir), before);
});
test("database failure rolls back successful earlier batch operations and receipt", async () => {
  const dir = await fixture(),
    operations = [
      { action: "create", kind: "posts", data: { title: "A" } },
      { action: "create", kind: "projects", data: { title: "B" } },
    ];
  const request = await approve(dir, operations, "rollback-batch-001");
  const db = new DatabaseSync(join(dir, "space.sqlite"));
  db.exec(
    "CREATE TRIGGER fail_projects BEFORE INSERT ON records WHEN NEW.kind='projects' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END",
  );
  db.close();
  const before = state(dir);
  await assert.rejects(run(dir, request));
  assert.equal(state(dir), before);
});
test("two separate CLI processes cannot overwrite each other", async () => {
  const dir = await fixture(),
    item = await get(dir);
  const results = await Promise.all(
    ["A", "B"].map((title, index) =>
      child(dir, {
        action: "apply",
        requestId: "concurrent-request-" + index,
        operations: [update(item, { title })],
      }),
    ),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
});
test("simultaneous draft save and publication produce one winner without lost data", async () => {
  const dir = await fixture();
  await apply(dir, update(await get(dir), { title: "Approved" }));
  const item = await get(dir),
    publication = await approve(dir, [
      {
        action: "publish",
        kind: "posts",
        id: item.id,
        expectedVersion: item.version,
        target: item.target,
      },
    ]);
  const results = await Promise.all([
    child(dir, publication),
    child(dir, {
      action: "apply",
      requestId: "concurrent-update-001",
      operations: [update(item, { title: "Later draft" })],
    }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  const current = await get(dir);
  assert.ok(
    current.live.title === "Approved" || current.draft.title === "Later draft",
  );
});
test("profile staging does not change live profile and rejects stale publication", async () => {
  const dir = await fixture(),
    profile = await get(dir, "profile", "profile");
  await apply(dir, update(profile, { name: "Pending name" }));
  let current = await get(dir, "profile", "profile");
  assert.equal(current.live.name, "Owner");
  assert.equal(current.draft.name, "Pending name");
  const db = new DatabaseSync(join(dir, "space.sqlite"));
  const live = JSON.parse(
    db.prepare("SELECT value FROM settings WHERE key='profile'").get().value,
  );
  live.name = "Saved in backend";
  live.revision++;
  db.prepare("UPDATE settings SET value=? WHERE key='profile'").run(
    JSON.stringify(live),
  );
  db.close();
  current = await get(dir, "profile", "profile");
  assert.equal(current.stale, true);
  await assert.rejects(
    run(dir, {
      action: "preview",
      operations: [
        {
          action: "publish",
          kind: "profile",
          id: "profile",
          expectedVersion: current.version,
          target: current.target,
        },
      ],
    }),
    { status: 409 },
  );
  assert.equal(current.live.name, "Saved in backend");
});
test("profile biography needs explicit scope and profile cannot be unpublished", async () => {
  const dir = await fixture(),
    item = await get(dir, "profile", "profile");
  await assert.rejects(
    apply(dir, update(item, { bio: "Changed without request" })),
  );
  await assert.rejects(
    run(dir, {
      action: "preview",
      operations: [
        {
          action: "unpublish",
          kind: "profile",
          id: "profile",
          expectedVersion: item.version,
          target: item.target,
        },
      ],
    }),
  );
  assert.equal((await get(dir, "profile", "profile")).live.bio, "Keep bio");
});
test("media upload replay returns identical URLs and media reads do not mutate data", async () => {
  const dir = await fixture(),
    request = {
      action: "media-upload",
      requestId: "media-request-001",
      files: [
        {
          name: "file.pdf",
          base64: Buffer.from("%PDF-1.4\nprivate attachment").toString(
            "base64",
          ),
        },
      ],
    };
  const first = await run(dir, request),
    repeated = await run(dir, request);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.files, first.files);
  const before = state(dir),
    name = first.files[0].url.split("/").at(-1);
  const response = await run(dir, { action: "media-get", names: [name] });
  assert.equal(response.files[0].mime, "application/pdf");
  assert.equal(state(dir), before);
  await assert.rejects(
    run(dir, { action: "media-get", names: ["../space.sqlite"] }),
  );
  await assert.rejects(
    run(dir, {
      ...request,
      files: [{ name: "different.pdf", base64: request.files[0].base64 }],
    }),
    { status: 409 },
  );
});
test("failed media receipt rolls back all newly created files", async () => {
  const dir = await fixture();
  const db = new DatabaseSync(join(dir, "space.sqlite"));
  db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON records WHEN NEW.kind='assistant_receipts' BEGIN SELECT RAISE(ABORT,'simulated receipt failure'); END",
  );
  db.close();
  const before = state(dir);
  await assert.rejects(
    run(dir, {
      action: "media-upload",
      requestId: "failing-media-001",
      files: [
        {
          name: "file.pdf",
          base64: Buffer.from("%PDF-1.4\nattachment").toString("base64"),
        },
      ],
    }),
  );
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(join(dir, "uploads")), []);
  assert.equal(state(dir), before);
});
