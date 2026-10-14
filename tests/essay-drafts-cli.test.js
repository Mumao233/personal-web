import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

const directories = [];
const article = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "personal-essay-cli-test-"));
  directories.push(dir);
  const db = new DatabaseSync(join(dir, "space.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  const insert = db.prepare("INSERT INTO records VALUES (?,?,?)");
  insert.run(
    "posts",
    "private-post",
    JSON.stringify({
      id: "private-post",
      title: "Live placeholder",
      body: "Live text",
      published: false,
      createdAt: "2026-01-01T00:00:00Z",
      revision: 3,
      privateMetadata: "never return",
      draftSavedAt: "2026-01-02T00:00:00Z",
      draft: {
        title: "Draft title",
        content: article("Draft text"),
        body: "Draft text",
        date: "2020-03-04",
        cover: "/uploads/private.jpg",
        location: "private location",
      },
    }),
  );
  insert.run(
    "posts",
    "published-post",
    JSON.stringify({
      id: "published-post",
      published: true,
      title: "Public text",
      revision: 4,
      draft: { title: "Private replacement", body: "Must not read" },
    }),
  );
  insert.run(
    "posts",
    "legacy-post",
    JSON.stringify({
      id: "legacy-post",
      title: "Legacy",
      body: "Plain text",
      published: false,
    }),
  );
  for (const kind of ["projects", "stories", "surveys", "messages", "outbox"])
    insert.run(
      kind,
      "private-post",
      JSON.stringify({ id: "private-post", private: kind + " secret" }),
    );
  db.prepare("INSERT INTO settings VALUES (?,?)").run(
    "private-settings",
    JSON.stringify({ private: "not visible" }),
  );
  db.close();
  return dir;
}

function connect(dir, readOnly = false) {
  return new DatabaseSync(join(dir, "space.sqlite"), { readOnly });
}
function snapshot(dir) {
  const db = connect(dir, true);
  try {
    return JSON.stringify({
      records: db.prepare("SELECT * FROM records ORDER BY kind,id").all(),
      settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
    });
  } finally {
    db.close();
  }
}
function record(dir, id) {
  const db = connect(dir, true);
  try {
    return JSON.parse(
      db.prepare("SELECT body FROM records WHERE kind='posts' AND id=?").get(id)
        .body,
    );
  } finally {
    db.close();
  }
}
async function call(dir, args, input, { raw = false, env = {} } = {}) {
  const child = spawn(
    process.execPath,
    ["server/essay-drafts-cli.js", ...args],
    {
      env: { ...process.env, DATA_DIR: dir, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(
    input === undefined ? "" : raw ? input : JSON.stringify(input),
  );
  const code = await done;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw Error("CLI did not return JSON: " + stderr);
  }
  return { code, data, stdout, stderr };
}
after(async () => {
  for (const dir of directories) {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(dir.includes("personal-essay-cli-test-"));
    await rm(dir, { recursive: true, force: true });
  }
});

test("list/get expose only unpublished post draft fields and never mutate the database", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  const listed = await call(dir, ["list"]);
  assert.equal(listed.code, 0);
  assert.deepEqual(
    listed.data.drafts.map((draft) => draft.id),
    ["legacy-post", "private-post"],
  );
  assert.equal(listed.data.drafts[1].title, "Draft title");
  assert.equal(listed.data.drafts[1].body, undefined);
  const detail = await call(dir, ["get", "private-post"]);
  assert.equal(detail.data.draft.body, "Draft text");
  assert.equal(detail.data.draft.revision, 3);
  assert.equal(detail.data.draft.date, "2020-03-04");
  for (const field of [
    "cover",
    "location",
    "privateMetadata",
    "published",
    "createdAt",
  ])
    assert.equal(detail.data.draft[field], undefined);
  assert.equal((await call(dir, ["get", "published-post"])).data.status, 404);
  assert.equal((await call(dir, ["get", "missing"])).data.status, 404);
  assert.equal(snapshot(dir), before);
});

test("create writes a private draft, preserves text paragraphs/date and returns its generated id", async () => {
  const dir = await fixture();
  const saved = await call(dir, ["create"], {
    revision: 0,
    title: "New essay",
    body: "First line\nNext line\n\nSecond paragraph",
    date: "2019-04-05",
    category: "Diary",
    excerpt: "Short",
  });
  assert.equal(saved.code, 0);
  assert.equal(saved.data.draft.revision, 1);
  assert.match(saved.data.draft.id, /^[0-9a-f-]{36}$/);
  assert.equal(
    saved.data.draft.body,
    "First line\nNext line\n\nSecond paragraph",
  );
  const stored = record(dir, saved.data.draft.id);
  assert.equal(stored.published, false);
  assert.equal(stored.title, "");
  assert.equal(stored.draft.title, "New essay");
  assert.equal(stored.draft.date, "2019-04-05");
});

test("legacy timestamp and freeform dates survive read, title-only update and unchanged round-trip", async () => {
  const dir = await fixture();
  const values = ["2024-02-29T16:30:00.000Z", "2020年春天"];
  const db = connect(dir);
  for (const [index, date] of values.entries()) {
    const id = `legacy-date-${index}`;
    db.prepare("INSERT INTO records VALUES('posts',?,?)").run(id, JSON.stringify({
      id, published: false, revision: 1, title: "旧内容", body: "旧正文",
      ...(index === 0 ? { date } : { draft: { title: "旧草稿", body: "旧正文", date } }),
    }));
  }
  db.close();
  const initial = snapshot(dir);
  assert.equal((await call(dir, ["list"])).code, 0);
  for (const [index, date] of values.entries()) {
    const read = await call(dir, ["get", `legacy-date-${index}`]);
    assert.equal(read.code, 0); assert.equal(read.data.draft.date, date);
  }
  assert.equal(snapshot(dir), initial, "legacy reads must not normalize stored dates");
  for (const [index, date] of values.entries()) {
    const id = `legacy-date-${index}`;
    const titleOnly = await call(dir, ["update", id], { revision: 1, title: "已改标题" });
    assert.equal(titleOnly.code, 0, titleOnly.stdout);
    assert.equal(titleOnly.data.draft.date, date);
    assert.equal(titleOnly.data.draft.revision, 2);
    assert.equal(record(dir, id).draft.date, date);
    const roundTrip = await call(dir, ["update", id], { revision: 2, title: "原样日期回传", date });
    assert.equal(roundTrip.code, 0, roundTrip.stdout);
    assert.equal(roundTrip.data.draft.date, date);
    assert.equal(record(dir, id).revision, 3);
    const beforeInvalid = snapshot(dir);
    for (const invalidDate of ["2023-02-29", "改变后的自由日期", "2024-03-01T00:00:00Z", null, 123, "x".repeat(41)]) {
      const rejected = await call(dir, ["update", id], { revision: 3, title: "不能写入", date: invalidDate });
      assert.equal(rejected.code, 1);
      assert.equal(rejected.data.status, 400);
      assert.equal(snapshot(dir), beforeInvalid, "invalid changed date must leave all data unchanged");
    }
    const calendar = await call(dir, ["update", id], { revision: 3, date: "2024-02-29" });
    assert.equal(calendar.code, 0); assert.equal(calendar.data.draft.date, "2024-02-29");
  }
  const beforeCreate = snapshot(dir);
  for (const date of values) {
    const rejected = await call(dir, ["create"], { revision: 0, title: "新文章", date });
    assert.equal(rejected.code, 1); assert.equal(rejected.data.status, 400);
  }
  assert.equal(snapshot(dir), beforeCreate);
});

test("update changes only draft/revision metadata and body replaces an old rich document explicitly", async () => {
  const dir = await fixture(),
    before = record(dir, "private-post");
  const saved = await call(dir, ["update", "private-post"], {
    revision: 3,
    body: "Replacement",
    title: "Changed",
  });
  assert.equal(saved.code, 0);
  const stored = record(dir, "private-post");
  assert.equal(stored.revision, 4);
  assert.equal(stored.draft.body, "Replacement");
  assert.equal(stored.draft.cover, before.draft.cover);
  assert.equal(stored.draft.location, before.draft.location);
  for (const field of [
    "id",
    "title",
    "body",
    "createdAt",
    "published",
    "privateMetadata",
  ])
    assert.deepEqual(stored[field], before[field]);
});

test("published records, including their pending drafts, reject all writes", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  for (const flags of [[], ["--dry-run"]]) {
    const response = await call(dir, ["update", "published-post", ...flags], {
      revision: 4,
      title: "Forbidden",
    });
    assert.equal(response.code, 1);
    assert.equal(response.data.status, 404);
  }
  assert.equal(snapshot(dir), before);
});

test("missing/stale/string revisions fail without overwriting a draft", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  for (const revision of [undefined, 0, 2, 4, "3", -1, 3.5]) {
    const response = await call(dir, ["update", "private-post"], {
      revision,
      title: "Stale",
    });
    assert.equal(response.data.status, 409);
    assert.equal(response.data.code, "REVISION_CONFLICT");
  }
  assert.equal(
    (await call(dir, ["create"], { revision: 1, title: "Bad creation" })).data
      .status,
    409,
  );
  assert.equal(snapshot(dir), before);
});

test("operation/argument/module/ID injection is rejected before opening or writing data", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  for (const args of [
    [],
    ["delete", "private-post"],
    ["publish", "private-post"],
    ["list", "--kind", "messages"],
    ["get", "new"],
    ["update", "new"],
    ["get", "x' OR 1=1--"],
    ["update", "../private-post"],
    ["create", "--database", "other"],
    ["list", "--dry-run"],
    ["get", "private-post", "extra"],
  ])
    assert.equal((await call(dir, args, { revision: 3 })).data.status, 400);
  assert.equal(snapshot(dir), before);
});

test("publication, deletion, private modules and prototype fields cannot cross the input whitelist", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  for (const key of [
    "published",
    "kind",
    "id",
    "draft",
    "createdAt",
    "cover",
    "photos",
    "location",
    "lat",
    "__proto__",
    "constructor",
    "admin",
    "delete",
  ])
    assert.equal(
      (
        await call(dir, ["update", "private-post"], {
          revision: 3,
          [key]: key === "published" ? true : "injected",
        })
      ).data.status,
      400,
    );
  assert.equal(snapshot(dir), before);
});

test("malformed JSON, wrong types, oversized fields and input are rejected safely", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  for (const raw of [
    "",
    "{private input",
    "null",
    "[]",
    "42",
    '"string"',
    " ".repeat(1024 * 1024 + 1),
  ]) {
    const response = await call(dir, ["create"], raw, { raw: true });
    assert.equal(response.data.status, 400);
    assert.equal(response.stdout.includes("private input"), false);
  }
  for (const invalid of [
    { title: 42 },
    { title: "a".repeat(301) },
    { body: "x".repeat(200001) },
    { content: null },
    { excerpt: [] },
    { date: "x".repeat(41) },
  ])
    assert.equal(
      (await call(dir, ["create"], { revision: 0, ...invalid })).data.status,
      400,
    );
  assert.equal(snapshot(dir), before);
});

test("rich content reuses server normalization and rejects unsupported nodes and unsafe links", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  for (const content of [
    {
      type: "doc",
      content: [{ type: "rawHTML", text: "<script>bad</script>" }],
    },
    {
      type: "doc",
      content: [{ type: "video", attrs: { src: "/uploads/private.mp4" } }],
    },
    {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://example.com/private.jpg" } },
      ],
    },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Bad",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    },
  ])
    assert.equal(
      (await call(dir, ["update", "private-post"], { revision: 3, content }))
        .data.status,
      400,
    );
  assert.equal(snapshot(dir), before);
  const saved = await call(dir, ["update", "private-post"], {
    revision: 3,
    content: article("Safe rich text"),
    body: "spoofed summary",
  });
  assert.equal(saved.code, 0);
  assert.equal(saved.data.draft.body, "Safe rich text");
});

test("dry-run create/update validates against a read-only connection and leaves all data unchanged", async () => {
  const dir = await fixture(),
    before = snapshot(dir);
  const created = await call(dir, ["create", "--dry-run"], {
    revision: 0,
    title: "Only validate",
  });
  assert.equal(created.code, 0);
  assert.equal(created.data.id, null);
  assert.equal(created.data.nextRevision, 1);
  const updated = await call(dir, ["update", "private-post", "--dry-run"], {
    revision: 3,
    title: "Only validate",
  });
  assert.equal(updated.code, 0);
  assert.equal(updated.data.nextRevision, 4);
  assert.equal(snapshot(dir), before);
});

test("simultaneous CLI writers admit one expected revision and reject the stale writer", async () => {
  const dir = await fixture();
  const results = await Promise.all(
    ["Writer one", "Writer two"].map((title) =>
      call(dir, ["update", "private-post"], { revision: 3, title }),
    ),
  );
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
  assert.equal(results.find((result) => result.code === 1).data.status, 409);
  assert.equal(record(dir, "private-post").revision, 4);
  assert.equal(
    record(dir, "private-post").draft.title,
    results.find((result) => result.code === 0).data.draft.title,
  );
});

test("administrator publication and CLI saving contend for the same transaction without losing a draft", async () => {
  const dir = await fixture();
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js", "--production"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      HOST: "127.0.0.1",
      TEST_MODE: "1",
      ATLAS_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Isolated admin startup timed out")),
        15000,
      );
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("Personal Space:")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", () => {});
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error("Isolated admin exited " + code));
      });
    });
    const setup = await fetch(base + "/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "synthetic-essay-test",
        password: "synthetic-essay-only-password",
      }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    for (let index = 0; index < 3; index++) {
      const id = "race-" + index;
      const db = connect(dir);
      db.prepare("INSERT INTO records VALUES ('posts',?,?)").run(
        id,
        JSON.stringify({
          id,
          published: false,
          revision: 0,
          draft: { title: "Original", body: "Original text" },
        }),
      );
      // Hold an independent writer lock until both operations have been issued.
      db.exec("BEGIN IMMEDIATE");
      const cli = call(dir, ["update", id], {
        revision: 0,
        title: "CLI replacement",
      });
      const publish = fetch(base + `/api/admin/posts/${id}/publish`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 0 }),
      });
      const release = setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, 350);
      const [saved, published] = await Promise.all([cli, publish]);
      clearTimeout(release);
      const final = record(dir, id);
      assert.equal(final.revision, 1);
      if (saved.code === 0) {
        assert.equal(published.status, 409);
        assert.equal(final.published, false);
        assert.equal(final.draft.title, "CLI replacement");
      } else {
        assert.equal(saved.data.status, 404);
        assert.equal(published.status, 200);
        assert.equal(final.published, true);
        assert.equal(final.title, "Original");
      }
    }
  } finally {
    if (child.exitCode === null) {
      const done = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await done;
    }
  }
});

test("SQLite write failures roll back draft changes and trigger side effects together", async () => {
  const dir = await fixture();
  const db = connect(dir);
  db.exec(
    "CREATE TRIGGER abort_draft AFTER UPDATE ON records WHEN NEW.kind='posts' BEGIN INSERT INTO settings VALUES ('rollback-probe','true'); SELECT RAISE(ABORT,'synthetic write failure'); END",
  );
  db.close();
  const before = snapshot(dir);
  const response = await call(dir, ["update", "private-post"], {
    revision: 3,
    title: "Must roll back",
  });
  assert.equal(response.code, 1);
  assert.equal(response.data.status, 500);
  assert.equal(snapshot(dir), before);
});

test("missing/relative DATA_DIR or absent DB never initializes another database", async () => {
  const dir = await fixture();
  for (const dataDir of ["", ".", join(dir, "missing")])
    assert.ok(
      (await call(dir, ["list"], undefined, { env: { DATA_DIR: dataDir } }))
        .code !== 0,
    );
  await assert.rejects(access(join(dir, "missing")));
});
