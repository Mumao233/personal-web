import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
let child, dir, cookie;
const base = "http://127.0.0.1:5187";
const definitionVersions = new Map();
const call = async (path, method = "GET", body, admin = false) => {
  const surveyIdForSubmit = path.match(/^\/surveys\/([^/]+)\/submit$/)?.[1];
  if (surveyIdForSubmit)
    body = {
      definitionVersion: definitionVersions.get(surveyIdForSubmit),
      ...body,
    };
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (data.id && data.definitionVersion)
    definitionVersions.set(data.id, data.definitionVersion);
  return { r, data };
};
async function start() {
  child = spawn(process.execPath, ["server/index.js", "--production"], {
    env: { ...process.env, DATA_DIR: dir, PORT: "5187", TEST_MODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error("Server startup timeout")), 15000);
    child.stdout.on("data", (b) => {
      if (b.toString().includes("Personal Space:")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("exit", (code) => reject(Error("Server exit " + code)));
  });
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "personal-space-test-"));
  await start();
});
after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 500));
  await rm(dir, { recursive: true, force: true });
});
test("administrator initialization, authorization and cross-site protection", async () => {
  assert.equal((await call("/admin")).r.status, 401);
  const setup = await call("/setup", "POST", {
    username: "test-admin",
    password: "testing-password-123",
  });
  assert.equal(setup.r.status, 200);
  cookie = setup.r.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /space_session=/);
  assert.equal((await call("/admin", "GET", null, true)).r.status, 200);
  assert.equal(
    (
      await call("/setup", "POST", {
        username: "x",
        password: "testing-password-456",
      })
    ).r.status,
    409,
  );
  const r = await fetch(base + "/api/admin/profile", {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: "https://other.example",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
});
test("private answers stay out of public feed; secret recovery and repeated contacts", async () => {
  const privateQ = await call("/questions", "POST", {
    question: "PRIVATE QUESTION",
    anonymous: true,
    public: false,
    recovery: "secret-phrase-123",
  });
  assert.equal(privateQ.r.status, 201);
  const feed = (await call("/public")).data;
  assert.equal(feed.messages.length, 0);
  assert.equal(JSON.stringify(feed).includes("PRIVATE QUESTION"), false);
  const recovered = await call("/recover", "POST", {
    key: "secret-phrase-123",
  });
  assert.equal(recovered.data.link, privateQ.data.link);
  const token = privateQ.data.link.split("=")[1];
  assert.equal(
    (await call("/answers/" + token)).data.question,
    "PRIVATE QUESTION",
  );
  assert.equal((await call("/answers/wrong")).r.status, 404);
  assert.equal(
    (
      await call("/questions", "POST", {
        question: "x",
        anonymous: true,
        recovery: "secret-phrase-123",
      })
    ).r.status,
    409,
  );
  for (let i = 0; i < 2; i++) {
    const response = await call("/questions", "POST", {
      question: "CONTACT " + i,
      anonymous: false,
      name: "Test name",
      public: true,
      recovery: "test@example.com",
    });
    assert.equal(response.r.status, 201);
    assert.ok(response.data.recoveryPhrase.length >= 8);
    assert.equal(
      (await call("/recover", "POST", { key: response.data.recoveryPhrase }))
        .data.link,
      response.data.link,
    );
  }
  const contact = await call("/recover", "POST", { key: "test@example.com" });
  assert.equal(contact.data.sent, true);
  assert.equal(contact.data.link, undefined);
  assert.equal(JSON.stringify(contact.data).includes("CONTACT"), false);
  const publicFeed = (await call("/public")).data;
  assert.equal(publicFeed.messages.length, 2);
  assert.ok(
    publicFeed.messages.every(
      (m) => !("contact" in m) && !("token" in m) && !("phraseHash" in m),
    ),
  );
  await call(
    "/admin/messages/" + privateQ.data.id,
    "PUT",
    { reply: "A private reply" },
    true,
  );
  assert.equal((await call("/answers/" + token)).data.reply, "A private reply");
  await call(
    "/admin/messages/" + publicFeed.messages[0].id,
    "PUT",
    { hidden: true },
    true,
  );
  assert.equal((await call("/public")).data.messages.length, 1);
  const outbox = (await call("/admin", "GET", null, true)).data.outbox;
  assert.ok(outbox.length >= 2);
  assert.ok(outbox.every((j) => j.status !== "sent"));
});
let surveyId;
test("all five survey types, conditional skipping, server validation and unlimited submissions", async () => {
  const questions = [
    {
      id: "single",
      type: "single",
      title: "Choice",
      options: ["A", "B"],
      required: true,
    },
    {
      id: "multi",
      type: "multiple",
      title: "Multi",
      options: ["A", "B", "C"],
      min: 1,
      max: 2,
      required: true,
    },
    {
      id: "rank",
      type: "rank",
      title: "Ranking",
      options: ["A", "B"],
      required: true,
    },
    {
      id: "multirank",
      type: "multirank",
      title: "Pick and rank",
      options: ["A", "B", "C"],
      min: 1,
      max: 2,
      required: true,
    },
    { id: "text", type: "text", title: "Text", required: true },
    {
      id: "conditional",
      type: "text",
      title: "Only B",
      required: true,
      condition: { questionId: "single", value: "B" },
    },
  ];
  const created = await call(
    "/admin/surveys/new",
    "PUT",
    { title: "Integration survey", published: true, questions },
    true,
  );
  assert.equal(created.r.status, 200);
  surveyId = created.data.id;
  assert.equal(
    (await call("/surveys/" + surveyId + "/submit", "POST", { answers: {} })).r
      .status,
    400,
  );
  const answers = {
    single: "A",
    multi: ["A", "B"],
    rank: ["B", "A"],
    multirank: ["C", "A"],
    text: "=SUM(1,1)",
    conditional: "SHOULD NOT BE SAVED",
  };
  assert.equal(
    (
      await call("/surveys/" + surveyId + "/submit", "POST", {
        answers: { ...answers, multi: ["A", "B", "C"] },
      })
    ).r.status,
    400,
  );
  assert.equal(
    (
      await call("/surveys/" + surveyId + "/submit", "POST", {
        answers: { ...answers, rank: ["B"] },
      })
    ).r.status,
    400,
  );
  assert.equal(
    (
      await call("/surveys/" + surveyId + "/submit", "POST", {
        answers: { ...answers, single: "B", conditional: "" },
      })
    ).r.status,
    400,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await call("/surveys/" + surveyId + "/submit", "POST", { answers })).r
        .status,
      201,
    );
  const results = await call(
    "/admin/surveys/" + surveyId + "/results",
    "GET",
    null,
    true,
  );
  assert.equal(results.data.rows.length, 2);
  assert.equal(results.data.rows[0].answers.conditional, undefined);
  assert.equal(results.data.summary.find((q) => q.id === "rank").rank.B, 1);
  assert.equal((await call("/surveys/" + surveyId + "/results")).r.status, 404);
});
test("CSV is formula-safe and Excel is a valid workbook", async () => {
  const csv = await fetch(
    base + "/api/admin/surveys/" + surveyId + "/export?format=csv",
    { headers: { Cookie: cookie } },
  );
  assert.match(await csv.text(), /'=SUM\(1,1\)/);
  const r = await fetch(
    base + "/api/admin/surveys/" + surveyId + "/export?format=xlsx",
    { headers: { Cookie: cookie } },
  );
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  assert.equal(wb.getWorksheet("答卷").rowCount, 3);
});
test("content drafts, closed surveys and administrator controls", async () => {
  const p = await call(
    "/admin/projects/new",
    "PUT",
    { title: "Draft", body: "Draft body", published: false },
    true,
  );
  assert.equal(
    (await call("/public")).data.projects.some((x) => x.id === p.data.id),
    false,
  );
  await call(
    "/admin/projects/" + p.data.id,
    "PUT",
    { ...p.data, published: true },
    true,
  );
  assert.equal(
    (await call("/public")).data.projects.some((x) => x.id === p.data.id),
    true,
  );
  const s = (await call("/surveys/" + surveyId)).data;
  await call("/admin/surveys/" + surveyId, "PUT", { ...s, closed: true }, true);
  assert.equal(
    (await call("/surveys/" + surveyId + "/submit", "POST", { answers: {} })).r
      .status,
    403,
  );
  const profile = (await call("/admin", "GET", undefined, true)).data.profile;
  await call(
    "/admin/profile",
    "PUT",
    { ...profile, acceptQuestions: false },
    true,
  );
  assert.equal(
    (await call("/questions", "POST", { question: "closed", anonymous: true }))
      .r.status,
    403,
  );
});
test("records and answers survive restart; sessions expire on restart", async () => {
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));
  await start();
  assert.equal((await call("/admin", "GET", null, true)).r.status, 401);
  const login = await call("/login", "POST", {
    username: "test-admin",
    password: "testing-password-123",
  });
  cookie = login.r.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await call("/admin/surveys/" + surveyId + "/results", "GET", null, true))
      .data.rows.length,
    2,
  );
  assert.equal(
    (await call("/recover", "POST", { key: "secret-phrase-123" })).r.status,
    200,
  );
});
