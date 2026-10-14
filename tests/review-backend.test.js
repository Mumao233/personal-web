import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { validateSurvey, validateAnswers } from "../server/validation.js";
import { surveyExport } from "../server/versions.js";

const unitDir = await mkdtemp(join(tmpdir(), "personal-notification-review-"));
process.env.DATA_DIR = unitDir;
process.env.TEST_MODE = "1";
const { list, get, put, remove, setSetting, transaction, db } =
  await import("../server/store.js");
const {
  notify,
  deliver,
  retryNotification,
  cancelNotifications,
  recoverNotificationJobs,
  normalizeContact,
  normalizeSiteOrigin,
  notificationLink,
} = await import("../server/notifications.js");
let child, httpDir, base, cookie;
const children = [];
const tempDirs = [];
async function startServer(dir, production = false) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const processChild = spawn(
    process.execPath,
    ["server/index.js", "--production"],
    {
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: String(port),
        TEST_MODE: production ? "" : "1",
        ATLAS_ENABLED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(processChild);
  await new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(Error("Startup timeout: " + log)),
      15000,
    );
    processChild.stderr.on("data", (chunk) => {
      log += chunk;
    });
    processChild.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Personal Space:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    processChild.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Server exit ${code}: ${log}`));
    });
  });
  return { child: processChild, base: `http://127.0.0.1:${port}` };
}
async function call(
  path,
  method = "GET",
  body,
  admin = false,
  extraHeaders = {},
) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), response };
}
before(async () => {
  httpDir = await mkdtemp(join(tmpdir(), "personal-http-review-"));
  tempDirs.push(httpDir);
  ({ child, base } = await startServer(httpDir));
  const setup = await call("/setup", "POST", {
    username: "synthetic",
    password: "synthetic-test-password",
  });
  assert.equal(setup.status, 200);
  cookie = setup.response.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  for (const processChild of children)
    if (processChild.exitCode === null) {
      const done = new Promise((resolve) => processChild.once("exit", resolve));
      processChild.kill();
      await done;
    }
  db.close();
  for (const dir of [unitDir, ...tempDirs])
    await rm(dir, { recursive: true, force: true });
});

test("production refuses every setup alias and the local CLI initializes without logging a password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "personal-production-init-review-"));
  tempDirs.push(dir);
  const production = await startServer(dir, true);
  for (const path of ["/api/setup", "/api/setup/", "/API/SETUP"])
    assert.equal(
      (
        await fetch(production.base + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "blocked",
            password: "synthetic-blocked-password",
          }),
        })
      ).status,
      403,
    );
  assert.equal(
    (await (await fetch(production.base + "/api/status")).json()).needsSetup,
    true,
  );
  const local = spawn(process.execPath, ["server/init-admin.js"], {
    env: { ...process.env, DATA_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  local.stdout.on("data", (chunk) => {
    output += chunk;
  });
  local.stderr.on("data", (chunk) => {
    output += chunk;
  });
  local.stdin.end(
    JSON.stringify({
      username: "cli-admin",
      password: "synthetic-cli-test-password",
    }),
  );
  const exit = await new Promise((resolve) => local.once("exit", resolve));
  assert.equal(exit, 0);
  assert.match(output, /初始化完成/);
  assert.doesNotMatch(output, /synthetic-cli-test-password/);
  assert.equal(
    (await (await fetch(production.base + "/api/status")).json()).needsSetup,
    false,
  );
  const login = await fetch(production.base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "cli-admin",
      password: "synthetic-cli-test-password",
    }),
  });
  assert.equal(login.status, 200);
});

test("private API aliases stay no-store and malformed Origin/contact inputs produce 4xx", async () => {
  for (const path of ["/api/admin", "/API/ADMIN", "/Api/Admin/"]) {
    const response = await fetch(base + path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const origin of ["null", "not-a-url"])
    assert.equal(
      (
        await call(
          "/questions",
          "POST",
          { question: "Synthetic", anonymous: true },
          false,
          { Origin: origin },
        )
      ).status,
      400,
    );
  for (const recovery of [123, {}, "a".repeat(321)])
    assert.equal(
      (
        await call("/questions", "POST", {
          question: "Synthetic",
          anonymous: true,
          recovery,
        })
      ).status,
      400,
    );
  for (const key of [123, {}, "a".repeat(321)])
    assert.equal((await call("/recover", "POST", { key })).status, 400);
  assert.equal(normalizeContact("a@" + "a.".repeat(100000) + "@"), null);
  assert.deepEqual(normalizeContact(" Example@Example.com "), {
    type: "email",
    value: "example@example.com",
  });
});

test("stale profile saves cannot re-expose a hidden field and survey saves cannot silently overwrite", async () => {
  const original = (await call("/admin", "GET", undefined, true)).data.profile;
  assert.equal(original.revision, 0);
  const privateProfile = await call(
    "/admin/profile",
    "PUT",
    {
      ...original,
      email: "synthetic@example.test",
      fields: [
        {
          id: "hidden-email",
          key: "email",
          label: "邮箱",
          value: "synthetic@example.test",
          href: "",
          visible: false,
        },
      ],
    },
    true,
  );
  assert.equal(privateProfile.status, 200);
  assert.equal(privateProfile.data.profile.revision, 1);
  const stale = await call(
    "/admin/profile",
    "PUT",
    { ...original, bio: "Stale edit" },
    true,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "PROFILE_REVISION_CONFLICT");
  assert.equal((await call("/public")).data.profile.email, "");
  const missing = await call("/admin/profile", "PUT", { name: "Stale" }, true);
  assert.equal(missing.status, 409);
  const survey = (
    await call(
      "/admin/surveys/new",
      "PUT",
      {
        title: "A",
        published: true,
        questions: [{ id: "q", title: "First meaning", type: "text" }],
      },
      true,
    )
  ).data;
  const changed = await call(
    `/admin/surveys/${survey.id}`,
    "PUT",
    { ...survey, title: "B" },
    true,
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.data.revision, 2);
  assert.notEqual(changed.data.definitionVersion, survey.definitionVersion);
  const outdated = await call(
    `/admin/surveys/${survey.id}`,
    "PUT",
    { ...survey, description: "Old window" },
    true,
  );
  assert.equal(outdated.status, 409);
  assert.equal(outdated.data.code, "SURVEY_REVISION_CONFLICT");
  assert.equal((await call(`/surveys/${survey.id}`)).data.title, "B");
  const recovered = await call(
    `/admin/surveys/${survey.id}`,
    "GET",
    undefined,
    true,
  );
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.title, "B");
  assert.equal(recovered.data.revision, changed.data.revision);
  assert.equal(
    recovered.data.definitionVersion,
    changed.data.definitionVersion,
  );
  assert.equal(
    (await call("/admin/surveys/missing", "GET", undefined, true)).status,
    404,
  );
});

test("survey version conflicts reject stale/missing definitions while successful retries replay across later edits and closure", async () => {
  let survey = (
    await call(
      "/admin/surveys/new",
      "PUT",
      {
        title: "Versioned",
        published: true,
        questions: [
          { id: "same", title: "Old meaning", type: "text", required: true },
        ],
      },
      true,
    )
  ).data;
  const original = survey;
  const payload = {
    answers: { same: "Original answer" },
    definitionVersion: survey.definitionVersion,
    submissionKey: randomUUID(),
  };
  const simultaneous = await Promise.all([
    call(`/surveys/${survey.id}/submit`, "POST", payload),
    call(`/surveys/${survey.id}/submit`, "POST", payload),
  ]);
  assert.ok(simultaneous.every((result) => result.status === 201));
  assert.deepEqual(simultaneous[0].data, simultaneous[1].data);
  survey = (
    await call(
      `/admin/surveys/${survey.id}`,
      "PUT",
      {
        ...survey,
        questions: [
          { ...survey.questions[0], title: "New meaning" },
          { id: "new", title: "New mandatory", type: "text", required: true },
        ],
      },
      true,
    )
  ).data;
  for (const body of [
    { answers: { same: "old" } },
    { answers: { same: "old" }, definitionVersion: original.definitionVersion },
  ]) {
    const conflict = await call(`/surveys/${survey.id}/submit`, "POST", body);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, "SURVEY_VERSION_CONFLICT");
  }
  const duplicate = await call(`/surveys/${survey.id}/submit`, "POST", payload);
  assert.equal(duplicate.status, 201);
  assert.deepEqual(duplicate.data, simultaneous[0].data);
  const collision = await call(`/surveys/${survey.id}/submit`, "POST", {
    ...payload,
    answers: { same: "different" },
  });
  assert.equal(collision.status, 409);
  assert.equal(collision.data.code, "SUBMISSION_KEY_CONFLICT");
  await call(
    `/admin/surveys/${survey.id}`,
    "PUT",
    { ...survey, closed: true },
    true,
  );
  assert.equal(
    (await call(`/surveys/${survey.id}/submit`, "POST", payload)).status,
    201,
  );
  const rows = (
    await call(`/admin/surveys/${survey.id}/results`, "GET", undefined, true)
  ).data.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].questions[0].title, "Old meaning");
  assert.equal(rows[0].definitionVersion, original.definitionVersion);
});

test("question retries are idempotent and deletion removes private notification/receipt payloads", async () => {
  // Earlier malformed submissions use the rate limiter; use a second isolated server.
  const dir = await mkdtemp(join(tmpdir(), "personal-question-retry-review-"));
  tempDirs.push(dir);
  const isolated = await startServer(dir);
  const previousBase = base,
    previousCookie = cookie;
  base = isolated.base;
  try {
    const setup = await call("/setup", "POST", {
      username: "retry",
      password: "synthetic-retry-password",
    });
    cookie = setup.response.headers.get("set-cookie").split(";")[0];
    const payload = {
      question: "Private synthetic question",
      anonymous: true,
      recovery: "synthetic@example.test",
      submissionKey: randomUUID(),
    };
    const first = await call("/questions", "POST", payload);
    const second = await call("/questions", "POST", payload);
    assert.equal(first.status, 201);
    assert.deepEqual(first.data, second.data);
    assert.equal(
      (await call("/admin", "GET", undefined, true)).data.messages.length,
      1,
    );
    await call(
      `/admin/messages/${first.data.id}`,
      "PUT",
      { reply: "Private synthetic reply" },
      true,
    );
    await call(`/admin/messages/${first.data.id}`, "DELETE", undefined, true);
    const jobs = (await call("/admin", "GET", undefined, true)).data.outbox;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "cancelled");
    for (const key of ["message", "contact", "token"])
      assert.equal(jobs[0][key], undefined);
    assert.equal((await call("/questions", "POST", payload)).status, 410);
    assert.equal(
      (await call(`/admin/outbox/${jobs[0].id}/retry`, "POST", {}, true))
        .status,
      409,
    );
  } finally {
    base = previousBase;
    cookie = previousCookie;
  }
});

test("accepted question receipts replay before rate limits while new logical submissions remain limited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "personal-receipt-rate-review-"));
  tempDirs.push(dir);
  const isolated = await startServer(dir);
  const previousBase = base,
    previousCookie = cookie;
  base = isolated.base;
  try {
    const setup = await call("/setup", "POST", {
      username: "receipt-rate",
      password: "synthetic-receipt-rate-password",
    });
    cookie = setup.response.headers.get("set-cookie").split(";")[0];
    const firstBody = {
      question: "Synthetic accepted question",
      anonymous: true,
      submissionKey: randomUUID(),
    };
    const first = await call("/questions", "POST", firstBody);
    assert.equal(first.status, 201);
    for (let index = 1; index < 8; index++) {
      const accepted = await call("/questions", "POST", {
        ...firstBody,
        submissionKey: randomUUID(),
      });
      assert.equal(accepted.status, 201);
    }
    const ninthBody = { ...firstBody, submissionKey: randomUUID() };
    assert.equal((await call("/questions", "POST", ninthBody)).status, 429);
    const replay = await call("/questions", "POST", firstBody);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.data, first.data);
    assert.equal((await call("/questions", "POST", ninthBody)).status, 429);
    assert.equal(
      (await call("/admin", "GET", undefined, true)).data.messages.length,
      8,
    );
  } finally {
    base = previousBase;
    cookie = previousCookie;
  }
});

test("legacy publishing requires location consent and conflict recovery can read the latest article", async () => {
  const body = {
    title: "Synthetic story",
    body: "Text",
    locationPrecision: "exact",
    lat: 12,
    lng: 34,
    published: true,
    confirmLocation: false,
  };
  assert.equal(
    (await call("/admin/stories/new", "PUT", body, true)).status,
    400,
  );
  const good = await call(
    "/admin/stories/new",
    "PUT",
    { ...body, confirmLocation: true },
    true,
  );
  assert.equal(good.status, 200);
  assert.equal(
    (await call(`/admin/stories/${good.data.id}`, "GET", undefined, true)).data
      .id,
    good.data.id,
  );
});

test("exports isolate changed meanings for the same ID and retain historical matrix labels", () => {
  const old = { id: "q", type: "text", title: "Old meaning" };
  const current = { id: "q", type: "text", title: "New meaning" };
  const rows = [
    { id: "old", questions: [old], answers: { q: "old response" } },
    { id: "new", questions: [current], answers: { q: "new response" } },
  ];
  const table = surveyExport({ questions: [current] }, rows);
  const oldColumn = table.headers.findIndex((header) =>
    header.startsWith("Old meaning"),
  );
  const newColumn = table.headers.findIndex((header) =>
    header.startsWith("New meaning"),
  );
  assert.notEqual(oldColumn, newColumn);
  assert.match(table.headers[oldColumn], /text \/ [a-f0-9]+/);
  assert.equal(table.values[0][oldColumn], "old response");
  assert.equal(table.values[0][newColumn], "");
  assert.equal(table.values[1][oldColumn], "");
  assert.equal(table.values[1][newColumn], "new response");
  const legacy = surveyExport({ questions: [current] }, [
    { id: "unknown", answers: { q: "historical value" } },
  ]);
  const unknownColumn = legacy.headers.findIndex((header) =>
    header.includes("历史定义缺失"),
  );
  assert.ok(unknownColumn >= 0);
  assert.equal(legacy.values[0][unknownColumn], "historical value");
  assert.equal(
    legacy.values[0][
      legacy.headers.findIndex((header) => header.startsWith("New meaning"))
    ],
    "",
  );
});

test("schema rejects unsatisfiable counts and inherited property IDs; inherited answers never satisfy required fields", () => {
  const baseQuestion = {
    id: "q",
    title: "Question",
    type: "single",
    options: ["A", "B"],
  };
  for (const override of [
    { min: 2 },
    { max: 2 },
    { type: "rank", max: 1 },
    { type: "rank", allowOther: true },
    { id: "toString" },
    { id: "valueOf" },
  ])
    assert.throws(() =>
      validateSurvey({
        title: "Survey",
        questions: [{ ...baseQuestion, ...override }],
      }),
    );
  const inherited = Object.create({ q: "A" });
  assert.throws(() =>
    validateAnswers(
      { questions: [{ ...baseQuestion, required: true }] },
      inherited,
    ),
  );
});

function resetJobs() {
  for (const kind of ["outbox", "messages"])
    for (const record of list(kind)) remove(kind, record.id);
  setSetting("notifications", {
    accessKeyId: "synthetic",
    accessKeySecret: "synthetic-secret",
    siteUrl: "https://example.test/?page=us",
  });
}
function syntheticMessage() {
  const message = {
    id: randomUUID(),
    token: randomUUID(),
    contact: { type: "email", value: "synthetic@example.test" },
  };
  put("messages", message);
  return message;
}
test("notification deletion cancels prefetched jobs and an in-flight completion cannot resurrect erased data", async () => {
  resetJobs();
  const laterMessage = syntheticMessage(),
    currentMessage = syntheticMessage();
  const later = notify(laterMessage, "Later private reply"),
    current = notify(currentMessage, "Current private reply");
  let release, began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const sent = [];
  const delivery = deliver({
    send: async (job, config, link) => {
      sent.push(job.id);
      assert.equal(new URL(link).searchParams.get("answer"), job.token);
      began();
      await barrier;
    },
  });
  await started;
  assert.equal(get("outbox", current.id).status, "sending");
  assert.throws(
    () => retryNotification(current.id),
    (error) => error.code === "NOTIFICATION_SENDING",
  );
  transaction(() => {
    for (const message of [currentMessage, laterMessage]) {
      cancelNotifications(message.id, message.token);
      remove("messages", message.id);
    }
  });
  release();
  await delivery;
  assert.deepEqual(sent, [current.id]);
  for (const job of [get("outbox", current.id), get("outbox", later.id)]) {
    assert.equal(job.status, "cancelled");
    assert.equal(job.message, undefined);
    assert.equal(job.contact, undefined);
    assert.equal(job.token, undefined);
  }
});

test("notification recovery associates legacy tasks, scrubs orphans, preserves uncertain sending state and supports explicit retry", async () => {
  resetJobs();
  const owner = syntheticMessage();
  put("outbox", {
    id: "legacy",
    token: owner.token,
    message: "Legacy",
    contact: owner.contact,
    status: "pending",
    attempts: 0,
  });
  put("outbox", {
    id: "orphan",
    token: "missing",
    message: "Orphan",
    contact: owner.contact,
    status: "pending",
    attempts: 0,
  });
  put("outbox", {
    id: "interrupted",
    messageId: owner.id,
    token: owner.token,
    message: "Uncertain",
    contact: owner.contact,
    status: "sending",
    attempts: 1,
  });
  recoverNotificationJobs();
  assert.equal(get("outbox", "legacy").messageId, owner.id);
  assert.equal(get("outbox", "orphan").status, "cancelled");
  assert.equal(get("outbox", "orphan").token, undefined);
  assert.equal(get("outbox", "interrupted").status, "failed");
  assert.match(get("outbox", "interrupted").error, /未知/);
  await deliver({
    send: async () => {
      throw Error("synthetic failure");
    },
  });
  assert.equal(get("outbox", "legacy").status, "failed");
  retryNotification("legacy");
  let attempts = 0;
  await deliver({
    send: async () => {
      attempts++;
    },
  });
  assert.equal(attempts, 1);
  assert.equal(get("outbox", "legacy").status, "sent");
  assert.equal(get("outbox", "legacy").attempts, 2);
  assert.throws(() => notificationLink({}, "synthetic"));
  assert.equal(
    normalizeSiteOrigin("https://example.test/path?page=us"),
    "https://example.test",
  );
  assert.throws(() => normalizeSiteOrigin("http://localhost:5193"));
});
