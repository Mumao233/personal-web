import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  adminGet,
  adminList,
  adminMutate,
  adminTarget,
  transitionContent,
} from "../server/admin-content.js";
import { publicProfile } from "../server/profile.js";
import {
  surveyDefinitionVersion,
  versionedSurvey,
  surveyExport,
} from "../server/versions.js";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE records(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id)); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)",
  );
  const store = {
    get(kind, id) {
      const row = db
        .prepare("SELECT body FROM records WHERE kind=? AND id=?")
        .get(kind, id);
      return row ? JSON.parse(row.body) : null;
    },
    list(kind) {
      return db
        .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind)
        .map((row) => JSON.parse(row.body));
    },
    put(kind, value) {
      db.prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      ).run(kind, value.id, JSON.stringify(value));
      return value;
    },
    setting(key) {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setSetting(key, value) {
      db.prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, JSON.stringify(value));
    },
    transaction(callback) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  store.setSetting("profile", {
    name: "测试用户",
    email: "",
    phone: "",
    wechat: "",
    github: "",
    intro: "原简介",
    bio: "原自述",
    revision: 2,
    acceptQuestions: true,
  });
  store.put(
    "surveys",
    versionedSurvey({
      id: "survey-old",
      title: "原问卷",
      description: "原说明",
      questions: [question()],
      published: true,
      revision: 4,
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  return { store, db };
}
function question() {
  return {
    id: "q1",
    title: "你的选择",
    type: "single",
    options: ["甲", "乙"],
    required: true,
  };
}
function mutation(store, view, action, data, extra = {}) {
  return adminMutate(store, {
    action,
    kind: view.kind,
    id: view.id,
    expectedVersion: view.version,
    ...(data ? { data } : {}),
    ...(["publish", "unpublish"].includes(action)
      ? { target: view.target }
      : {}),
    ...extra,
  });
}
const fails = (fn, status = 400, code) =>
  assert.throws(
    fn,
    (error) => error.status === status && (!code || error.code === code),
  );

test("articles share saved drafts and preserve live fields until an explicit target publication", (t) => {
  const { store } = fixture(t);
  const draft = adminMutate(store, {
    action: "create",
    kind: "posts",
    data: { title: "草稿", body: "第一段\n\n第二段" },
  });
  assert.equal(draft.published, false);
  assert.equal(draft.draft.body, "第一段\n\n第二段");
  assert.equal(draft.draft.content.content.length, 2);
  fails(() =>
    mutation(store, draft, "publish", undefined, {
      target: "https://example.com/",
    }),
  );
  const live = mutation(store, draft, "publish");
  assert.equal(live.published, true);
  assert.equal(live.hasDraft, false);
  assert.equal(live.url, adminTarget("posts", live.id));
  const edited = mutation(store, live, "update", { title: "新标题" });
  assert.equal(edited.live.title, "草稿");
  assert.equal(edited.draft.title, "新标题");
  assert.equal(edited.draft.body, live.live.body);
  const withdrawn = mutation(store, edited, "unpublish");
  assert.equal(withdrawn.published, false);
  assert.equal(withdrawn.draft.title, "新标题");
});

test("strict module/data boundaries do not expose unknown fields, contacts or security records", (t) => {
  const { store } = fixture(t);
  store.put("posts", {
    id: "post1",
    title: "文章",
    body: "正文",
    revision: 1,
    published: false,
    secret: "hidden",
    token: "hidden",
  });
  store.put("messages", {
    id: "msg1",
    question: "private",
    contact: "private",
  });
  store.setSetting("notifications", { accessKeySecret: "private" });
  const output = JSON.stringify(adminList(store, "posts"));
  assert.ok(!output.includes("hidden"));
  assert.ok(!output.includes("private"));
  for (const kind of [
    "messages",
    "submissions",
    "notifications",
    "outbox",
    "assistant_drafts",
    "__proto__",
  ])
    fails(() => adminList(store, kind));
  for (const data of [
    { published: true },
    { id: "another" },
    { draft: {} },
    { revision: 4 },
    { photos: [] },
  ])
    fails(() => adminMutate(store, { action: "create", kind: "posts", data }));
  fails(() => adminGet(store, "posts", "../settings"));
  fails(() =>
    adminMutate(store, { action: "delete", kind: "posts", id: "post1" }),
  );
});

test("article conflict prevents an assistant update after the original editor publishes", (t) => {
  const { store } = fixture(t);
  const draft = adminMutate(store, {
    action: "create",
    kind: "projects",
    data: { title: "作品" },
  });
  transitionContent(
    store,
    "projects",
    draft.id,
    { revision: draft.liveRevision },
    "publish",
  );
  fails(() => mutation(store, draft, "update", { title: "过期修改" }), 409);
  assert.equal(adminGet(store, "projects", draft.id).live.title, "作品");
});

test("article publication reuses project URL and story exact location confirmation", (t) => {
  const { store } = fixture(t);
  const project = adminMutate(store, {
    action: "create",
    kind: "projects",
    data: { title: "作品", link: "javascript:alert(1)" },
  });
  fails(() => mutation(store, project, "publish"));
  const story = adminMutate(store, {
    action: "create",
    kind: "stories",
    data: { title: "照片", locationPrecision: "exact", lat: 23, lng: 113 },
  });
  fails(() => mutation(store, story, "publish"));
  const confirmed = mutation(store, story, "update", { confirmLocation: true });
  assert.equal(mutation(store, confirmed, "publish").published, true);
});

test("profile assistant draft is isolated from the original public setting and original editor", (t) => {
  const { store } = fixture(t);
  const old = store.setting("profile");
  const view = adminGet(store, "profile", "profile");
  const draft = mutation(store, view, "update", {
    name: "草稿名字",
    portrait: "/uploads/draft.jpg",
  });
  assert.deepEqual(store.setting("profile"), old);
  assert.equal(publicProfile(store.setting("profile")).portrait, undefined);
  assert.equal(draft.draft.name, "草稿名字");
  assert.equal(draft.live.name, "测试用户");
  assert.equal(draft.target, "https://mumao.site/?page=about");
  assert.equal(adminList(store, "profile").length, 1);
  const published = mutation(store, draft, "publish");
  assert.equal(store.setting("profile").name, "草稿名字");
  assert.equal(published.hasDraft, false);
  assert.equal(published.liveRevision, 3);
  fails(() => mutation(store, published, "unpublish"));
  fails(() =>
    adminMutate(store, { action: "create", kind: "profile", data: {} }),
  );
});

test("profile staged snapshot is stale after direct administration and needs explicit rebase", (t) => {
  const { store } = fixture(t);
  const draft = mutation(
    store,
    adminGet(store, "profile", "profile"),
    "update",
    { name: "助手草稿" },
  );
  store.setSetting("profile", {
    ...store.setting("profile"),
    name: "网页新名字",
    revision: 3,
  });
  fails(() => mutation(store, draft, "publish"), 409, "REVISION_CONFLICT");
  const latest = adminGet(store, "profile", "profile");
  assert.equal(latest.stale, true);
  assert.equal(latest.live.name, "网页新名字");
  fails(() => mutation(store, latest, "publish"), 409, "STALE_DRAFT");
  fails(
    () => mutation(store, latest, "update", { name: "核对后的名字" }),
    409,
    "STALE_DRAFT",
  );
  fails(() =>
    mutation(
      store,
      latest,
      "update",
      { name: "核对后的名字" },
      { resolveStale: true },
    ),
  );
  const rebased = mutation(
    store,
    latest,
    "update",
    { ...latest.draft, ...latest.live, name: "核对后的名字" },
    { resolveStale: true },
  );
  assert.equal(rebased.stale, false);
  assert.equal(mutation(store, rebased, "publish").live.name, "核对后的名字");
  fails(
    () =>
      mutation(store, rebased, "update", rebased.draft, { resolveStale: true }),
    409,
  );
});

test("bio changes require specific authorization at staging and publication", (t) => {
  const { store } = fixture(t);
  const view = adminGet(store, "profile", "profile");
  fails(
    () => mutation(store, view, "update", { bio: "新自述" }),
    400,
    "BIO_CHANGE_REQUIRES_CONFIRMATION",
  );
  const staged = mutation(
    store,
    view,
    "update",
    { bio: "新自述" },
    { allowBioChange: true },
  );
  fails(
    () => mutation(store, staged, "publish"),
    400,
    "BIO_CHANGE_REQUIRES_CONFIRMATION",
  );
  assert.equal(
    mutation(store, staged, "publish", undefined, { allowBioChange: true }).live
      .bio,
    "新自述",
  );
});

test("new survey drafts remain only in assistant storage until complete and published", (t) => {
  const { store } = fixture(t);
  const initialCount = store.list("surveys").length;
  const draft = adminMutate(store, {
    action: "create",
    kind: "surveys",
    data: { title: "待写问卷", questions: [] },
  });
  assert.equal(draft.live, null);
  assert.equal(draft.published, false);
  assert.equal(store.list("surveys").length, initialCount);
  assert.equal(adminList(store, "surveys").length, initialCount + 1);
  fails(() => mutation(store, draft, "publish"));
  const complete = mutation(store, draft, "update", {
    questions: [question()],
  });
  const published = mutation(store, complete, "publish");
  assert.equal(published.published, true);
  assert.equal(
    store.get("surveys", published.id).definitionVersion,
    surveyDefinitionVersion(published.live),
  );
  assert.equal(published.hasDraft, false);
  assert.equal(adminList(store, "surveys").length, initialCount + 1);
});

test("survey publication keeps old answer snapshots and withdrawal does not erase them", (t) => {
  const { store } = fixture(t);
  const old = store.get("surveys", "survey-old");
  const response = {
    id: "answer1",
    surveyId: old.id,
    surveyTitle: old.title,
    definitionVersion: old.definitionVersion,
    questions: old.questions,
    answers: { q1: "甲" },
  };
  store.put("submissions", response);
  const draft = mutation(store, adminGet(store, "surveys", old.id), "update", {
    title: "新版问卷",
    questions: [{ ...question(), title: "新的题意" }],
  });
  assert.deepEqual(store.get("surveys", old.id), old);
  assert.equal(draft.liveRevision, 4);
  const published = mutation(store, draft, "publish");
  assert.notEqual(
    store.get("surveys", old.id).definitionVersion,
    old.definitionVersion,
  );
  assert.deepEqual(store.get("submissions", response.id), response);
  const exported = surveyExport(store.get("surveys", old.id), [response]);
  assert.ok(exported.headers.some((text) => text.includes("你的选择")));
  assert.ok(exported.headers.some((text) => text.includes("新的题意")));
  mutation(store, published, "unpublish");
  assert.equal(store.get("surveys", old.id).published, false);
  assert.deepEqual(store.get("submissions", response.id), response);
});

test("survey direct save invalidates an assistant draft even if revision was not changed", (t) => {
  const { store } = fixture(t);
  mutation(store, adminGet(store, "surveys", "survey-old"), "update", {
    title: "助手标题",
  });
  store.put("surveys", {
    ...store.get("surveys", "survey-old"),
    title: "网页新标题",
  });
  const latest = adminGet(store, "surveys", "survey-old");
  assert.equal(latest.stale, true);
  fails(() => mutation(store, latest, "publish"), 409);
});

test("structured survey/profile input rejects nested injections and malformed values", (t) => {
  const { store } = fixture(t);
  for (const data of [
    { questions: [{ ...question(), token: "bad" }] },
    { questions: [{ ...question(), required: "true" }] },
    { closed: "false" },
    {
      questions: [
        {
          ...question(),
          condition: { questionId: "q0", value: "甲", sql: "bad" },
        },
      ],
    },
  ])
    fails(() =>
      mutation(store, adminGet(store, "surveys", "survey-old"), "update", data),
    );
  for (const data of [
    { accessKeySecret: "bad" },
    { fields: [{ id: "test", label: "测试", value: "x", visible: "false" }] },
    {
      interests: [{ title: "测试", text: "说明", status: "好", secret: "bad" }],
    },
    { bio: 1 },
  ])
    fails(() =>
      mutation(store, adminGet(store, "profile", "profile"), "update", data),
    );
});

test("all mutating operations require current versions and publication cannot sneak in data", (t) => {
  const { store } = fixture(t);
  for (const kind of ["surveys", "profile"]) {
    const id = kind === "profile" ? "profile" : "survey-old";
    fails(
      () =>
        adminMutate(store, {
          action: "update",
          kind,
          id,
          data: { name: "wrong" },
        }),
      409,
    );
  }
  const draft = adminMutate(store, {
    action: "create",
    kind: "posts",
    data: { title: "标题" },
  });
  fails(() => mutation(store, draft, "publish", { title: "未经预览的替换" }));
  fails(() =>
    mutation(store, draft, "unpublish", undefined, {
      target: "https://mumao.site/?post=other",
    }),
  );
});

test("a storage failure rolls publication back, keeping both live and assistant draft", (t) => {
  const { store } = fixture(t);
  const draft = mutation(
    store,
    adminGet(store, "profile", "profile"),
    "update",
    { name: "待发布" },
  );
  const previous = store.setting("profile");
  const broken = {
    ...store,
    put(kind, value) {
      if (kind === "assistant_drafts" && value.data === null)
        throw Error("synthetic storage fault");
      return store.put(kind, value);
    },
  };
  assert.throws(
    () => mutation(broken, draft, "publish"),
    /synthetic storage fault/,
  );
  assert.deepEqual(store.setting("profile"), previous);
  assert.equal(adminGet(store, "profile", "profile").version, draft.version);
});

test("shared business operations participate in one atomic caller transaction", (t) => {
  const { store } = fixture(t);
  const locked = { ...store, transaction: (callback) => callback() };
  assert.throws(() =>
    store.transaction(() => {
      adminMutate(locked, {
        action: "create",
        kind: "posts",
        data: { title: "不会残留" },
      });
      adminMutate(locked, {
        action: "create",
        kind: "surveys",
        data: { questions: "invalid" },
      });
    }),
  );
  assert.equal(store.list("posts").length, 0);
  assert.equal(store.list("assistant_drafts").length, 0);
});
