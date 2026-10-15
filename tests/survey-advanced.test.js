import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import ExcelJS from "exceljs";
import {
  validateSurvey,
  validateAnswers,
  surveyFlow,
  answerError,
  exclusiveOptionsFor,
  summarizeSurvey,
  surveyCompletionCounts,
} from "../server/validation.js";

const matrix = {
  id: "scale",
  title: "Experience",
  type: "matrix",
  required: true,
  rows: [
    { id: "r1", title: "Clear" },
    { id: "r2", title: "Useful" },
  ],
  options: [
    "Strongly disagree",
    "Disagree",
    "Neutral",
    "Agree",
    "Strongly agree",
  ],
};
const makeSurvey = () => ({
  title: "Advanced survey",
  published: true,
  publicResults: true,
  terminationMessage: "Screening complete, thank you.",
  questions: [
    {
      id: "gate",
      title: "Continue?",
      type: "single",
      required: true,
      options: ["yes", "no"],
    },
    {
      id: "screen",
      title: "Eligible?",
      type: "single",
      required: true,
      options: ["continue", "stop"],
      terminateOptions: ["stop"],
      condition: { questionId: "gate", value: "yes" },
    },
    structuredClone(matrix),
    {
      id: "selection",
      title: "Choose two",
      type: "multiple",
      required: true,
      min: 2,
      max: 2,
      options: ["A", "B", "以上都无"],
    },
    { id: "text", title: "Comment", type: "text", required: true },
  ],
});

test("matrix answers require all rows, reject unknown rows/choices and retain optional partial answers", () => {
  const survey = { questions: [matrix] };
  assert.match(answerError(matrix, { scale: { r1: "Agree" } }), /Useful/);
  for (const scale of [
    [],
    ["Agree"],
    "Agree",
    { r1: "Agree", r2: "invalid" },
    { r1: "Agree", r2: "Agree", extra: "Agree" },
  ])
    assert.throws(() => validateAnswers(survey, { scale }), /矩阵|请回答/);
  assert.deepEqual(
    validateAnswers(survey, { scale: { r1: "Agree", r2: "Neutral" } }),
    { scale: { r1: "Agree", r2: "Neutral" } },
  );
  const optional = { ...matrix, required: false };
  assert.deepEqual(
    validateAnswers(
      { questions: [optional] },
      { scale: { r1: "Agree", r2: "" } },
    ),
    { scale: { r1: "Agree" } },
  );
  assert.deepEqual(
    validateAnswers({ questions: [optional] }, { scale: {} }),
    {},
  );
  assert.throws(
    () => validateAnswers({ questions: [optional] }, { scale: [] }),
    /矩阵/,
  );
});

test("exclusive singleton bypasses minimum and exact legacy 以上都无 is always exclusive", () => {
  for (const type of ["multiple", "multirank"]) {
    const question = {
      id: "choice",
      title: "Choose",
      type,
      required: true,
      min: 2,
      max: 3,
      options: ["A", "B", "以上都无", "custom none"],
      exclusiveOptions: ["custom none"],
    };
    assert.deepEqual(exclusiveOptionsFor(question), [
      "custom none",
      "以上都无",
    ]);
    for (const value of [["以上都无"], ["custom none"], ["A", "B"]])
      assert.equal(answerError(question, { choice: value }), "");
    for (const value of [["以上都无", "A"], ["custom none", "以上都无"], ["A"]])
      assert.notEqual(answerError(question, { choice: value }), "");
    const legacy = { ...question, exclusiveOptions: undefined };
    assert.equal(answerError(legacy, { choice: ["以上都无"] }), "");
    assert.match(answerError(legacy, { choice: ["以上都无", "A"] }), /互斥/);
  }
  assert.deepEqual(
    exclusiveOptionsFor({ type: "single", options: ["以上都无", "A"] }),
    [],
  );
});

test("survey schema rejects malformed matrices and invalid termination/exclusive rules", () => {
  assert.doesNotThrow(() => validateSurvey(makeSurvey()));
  for (const change of [
    {
      rows: [
        { id: "duplicate", title: "One" },
        { id: "duplicate", title: "Two" },
      ],
    },
    { rows: [] },
    { rows: [{ id: "__proto__", title: "Unsafe" }] },
    { terminateOptions: ["Agree"] },
    { exclusiveOptions: ["Agree"] },
    { allowOther: true },
  ])
    assert.throws(() =>
      validateSurvey({
        title: "Invalid",
        questions: [{ ...matrix, ...change }],
      }),
    );
  for (const change of [
    { terminateOptions: ["missing"] },
    { terminateOptions: ["A", "A"] },
    { exclusiveOptions: ["missing"] },
    { exclusiveOptions: "A" },
    { type: "rank", terminateOptions: ["A"] },
    { type: "single", exclusiveOptions: ["A"] },
  ])
    assert.throws(() =>
      validateSurvey({
        title: "Invalid",
        questions: [
          {
            id: "q",
            title: "Q",
            type: "multiple",
            options: ["A", "B"],
            ...change,
          },
        ],
      }),
    );
  assert.doesNotThrow(() =>
    validateSurvey({
      title: "Other",
      questions: [
        {
          id: "q",
          title: "Q",
          type: "multiple",
          options: ["A", "B"],
          allowOther: true,
          terminateOptions: ["其他"],
          exclusiveOptions: ["其他"],
        },
      ],
    }),
  );
});

test("flow terminates only at a visible valid choice and ignores stale downstream answers", () => {
  const survey = makeSurvey();
  const ended = {
    gate: "yes",
    screen: "stop",
    scale: { broken: "invalid" },
    selection: ["invalid"],
    text: "STALE",
    text__other: "STALE",
  };
  assert.deepEqual(
    surveyFlow(survey, ended).questions.map((q) => q.id),
    ["gate", "screen"],
  );
  assert.deepEqual(surveyFlow(survey, ended).termination, {
    questionId: "screen",
    questionTitle: "Eligible?",
    option: "stop",
  });
  assert.deepEqual(validateAnswers(survey, ended), {
    gate: "yes",
    screen: "stop",
  });
  const hidden = {
    gate: "no",
    screen: "stop",
    scale: { r1: "Agree", r2: "Neutral" },
    selection: ["以上都无"],
    text: "Full response",
  };
  assert.equal(surveyFlow(survey, hidden).termination, null);
  assert.equal(validateAnswers(survey, hidden).screen, undefined);
  assert.throws(
    () => validateAnswers(survey, { ...ended, gate: undefined }),
    /Continue/,
  );
  const invalidEnd = {
    questions: [
      {
        id: "q",
        title: "Q",
        type: "multiple",
        options: ["stop", "continue", "以上都无"],
        terminateOptions: ["stop"],
        min: 2,
      },
      { id: "later", title: "Later", type: "text", required: true },
    ],
  };
  assert.equal(
    surveyFlow(invalidEnd, { q: ["stop"] }).termination.option,
    "stop",
  );
  assert.deepEqual(
    validateAnswers(invalidEnd, { q: ["stop"], later: "stale" }),
    { q: ["stop"] },
  );
  assert.match(
    answerError(invalidEnd.questions[0], { q: ["continue"] }),
    /数量/,
  );
  assert.equal(
    surveyFlow(invalidEnd, { q: ["stop", "以上都无"] }).termination,
    null,
  );
  assert.equal(
    surveyFlow(invalidEnd, { q: ["stop", "continue"] }).termination.option,
    "stop",
  );
  const endOther = {
    id: "other",
    title: "Other terminal",
    type: "multirank",
    min: 2,
    max: 2,
    options: ["A", "B"],
    allowOther: true,
    terminateOptions: ["其他"],
  };
  assert.match(answerError(endOther, { other: ["其他"] }), /补充/);
  assert.equal(
    answerError(endOther, { other: ["其他"], other__other: "End here" }),
    "",
  );
  assert.match(
    answerError(endOther, {
      other: ["A", "B", "其他"],
      other__other: "End here",
    }),
    /数量/,
  );
});

test("matrix summaries and completion counts accept filtered submissions and legacy completions", () => {
  const rows = [
    { answers: { scale: { r1: "Agree", r2: "Neutral" } } },
    {
      completion: "completed",
      answers: { scale: { r1: "Agree", r2: "Strongly agree" } },
    },
    { completion: "terminated", answers: {} },
  ];
  assert.deepEqual(surveyCompletionCounts(rows), {
    completed: 2,
    terminated: 1,
  });
  const summary = summarizeSurvey({ questions: [matrix] }, rows)[0];
  assert.equal(summary.counts, null);
  assert.equal(summary.answered, 2);
  assert.equal(summary.matrix[0].counts.Agree, 2);
  assert.equal(summary.matrix[1].counts.Neutral, 1);
  assert.equal(
    summarizeSurvey(
      { questions: [matrix] },
      rows.filter((row) => row.completion === "terminated"),
    )[0].matrix[0].answered,
    0,
  );
});

let child, dir, cookie, base;
const definitionVersions = new Map();
async function call(path, method = "GET", body, admin = false) {
  const surveyIdForSubmit = path.match(/^\/surveys\/([^/]+)\/submit$/)?.[1];
  if (surveyIdForSubmit)
    body = {
      definitionVersion: definitionVersions.get(surveyIdForSubmit),
      ...body,
    };
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (data.id && data.definitionVersion)
    definitionVersions.set(data.id, data.definitionVersion);
  return { status: response.status, data, response };
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "personal-space-survey-test-"));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js", "--production"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      TEST_MODE: "1",
      ATLAS_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let log = "";
    const timeout = setTimeout(
      () => reject(Error("Survey server startup timeout: " + log)),
      15000,
    );
    child.stderr.on("data", (chunk) => {
      log += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Personal Space:")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(Error(`Survey server exited ${code}: ${log}`));
    });
  });
  const setup = await call("/setup", "POST", {
    username: "advanced-survey",
    password: "advanced-survey-test-123",
  });
  assert.equal(setup.status, 200);
  cookie = setup.response.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("API computes completion, matrix statistics, filtered export and prevents deleting answered matrix rows", async () => {
  const created = await call("/admin/surveys/new", "PUT", makeSurvey(), true);
  assert.equal(created.status, 200);
  const id = created.data.id;
  const full = await call(`/surveys/${id}/submit`, "POST", {
    answers: {
      gate: "no",
      screen: "stop",
      scale: { r1: "Agree", r2: "Neutral" },
      selection: ["以上都无"],
      text: "=SUM(1,1)",
    },
    completion: "terminated",
    termination: { option: "forged" },
  });
  assert.equal(full.status, 201);
  assert.equal(full.data.completion, "completed");
  assert.equal(full.data.termination, null);
  const ended = await call(`/surveys/${id}/submit`, "POST", {
    answers: {
      gate: "yes",
      screen: "stop",
      scale: { invalid: "invalid" },
      text: "IGNORED",
    },
    completion: "completed",
  });
  assert.equal(ended.status, 201);
  assert.equal(ended.data.completion, "terminated");
  assert.equal(ended.data.message, makeSurvey().terminationMessage);
  const results = await call(
    `/admin/surveys/${id}/results`,
    "GET",
    undefined,
    true,
  );
  assert.deepEqual(results.data.completionCounts, {
    completed: 1,
    terminated: 1,
  });
  assert.equal(
    results.data.rows.find((row) => row.completion === "terminated").answers
      .text,
    undefined,
  );
  assert.equal(
    results.data.rows.find((row) => row.completion === "completed").answers
      .screen,
    undefined,
  );
  assert.equal(
    results.data.summary.find((q) => q.id === "scale").matrix[0].counts.Agree,
    1,
  );
  const publicResults = await call(`/surveys/${id}/results`);
  assert.deepEqual(publicResults.data.completionCounts, {
    completed: 1,
    terminated: 1,
  });
  assert.equal(publicResults.data.rows, undefined);
  const updatedSurvey = {
    ...created.data,
    questions: created.data.questions.map((q) =>
      q.id === "scale" ? { ...q, rows: [q.rows[0]] } : q,
    ),
  };
  const blocked = await call(`/admin/surveys/${id}`, "PUT", updatedSurvey, true);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.code, "SURVEY_VALIDATION_FAILED");
  assert.ok(blocked.data.issues.some((issue) => issue.questionId === "scale" && issue.field === "rows" && issue.code === "historical_row_removed"));
  const unchanged = await call(`/admin/surveys/${id}`, "GET", undefined, true);
  assert.equal(unchanged.data.revision, created.data.revision);
  assert.equal(unchanged.data.questions.find((question) => question.id === "scale").rows.length, 2);
  const csv = await fetch(`${base}/api/admin/surveys/${id}/export?format=csv`, {
    headers: { Cookie: cookie },
  });
  const csvText = await csv.text();
  assert.match(csvText, /Experience · Useful/);
  assert.match(csvText, /Neutral/);
  assert.match(csvText, /提前结束/);
  assert.match(csvText, /Eligible\?/);
  assert.match(csvText, /'=SUM\(1,1\)/);
  assert.equal(csvText.includes("[object Object]"), false);
  const response = await fetch(
    `${base}/api/admin/surveys/${id}/export?format=xlsx&completion=completed`,
    { headers: { Cookie: cookie } },
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.getWorksheet("答卷");
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getRow(2).getCell(3).value, "完整完成");
  const headers = sheet.getRow(1).values;
  const historicalColumn = headers.findIndex((header) =>
    String(header).startsWith("Experience · Useful"),
  );
  assert.ok(historicalColumn > 0);
  assert.equal(sheet.getRow(2).getCell(historicalColumn).value, "Neutral");
  const invalid = await call(`/surveys/${id}/submit`, "POST", {
    answers: {
      gate: "no",
      scale: { r1: "Agree" },
      selection: ["A", "以上都无"],
      text: "Invalid exclusive",
    },
  });
  assert.equal(invalid.status, 400);
});

test("API normalizes all option types, reports all save errors and preserves history, references and revision locks", async () => {
  const definition = {
    title: "Isolated normalization fixture",
    published: true,
    questions: ["single", "multiple", "rank", "multirank", "matrix"].map((type) => ({
      id: type, type, title: `${type} options`,
      options: ["", " A ", "\t", "B", "\r\n", ""],
      ...(type === "matrix" ? { rows: [{ id: "row", title: "matrix row" }] } : {}),
    })),
  };
  definition.questions.push({ id: "text", title: "text ignores option rules", type: "text", options: ["", ""] });
  const created = await call("/admin/surveys/new", "PUT", definition, true);
  assert.equal(created.status, 200);
  const saved = created.data;
  for (const question of saved.questions.filter((question) => question.type !== "text"))
    assert.deepEqual(question.options, [" A ", "B"]);
  const answers = { single: " A ", multiple: [" A "], rank: ["B", " A "], multirank: [" A "], matrix: { row: " A " }, text: "unchanged" };
  const response = await call(`/surveys/${saved.id}/submit`, "POST", { answers });
  assert.equal(response.status, 201);
  const resultsBefore = (await call(`/admin/surveys/${saved.id}/results`, "GET", undefined, true)).data;
  const invalid = structuredClone(saved);
  invalid.questions[0].options = ["A", "A", ""];
  invalid.questions[1].options = ["", "one", " "];
  invalid.questions[4].options = ["only"];
  const rejected = await call(`/admin/surveys/${saved.id}`, "PUT", invalid, true);
  assert.equal(rejected.status, 400);
  for (const [questionId, code] of [["single", "option_duplicate"], ["single", "historical_option_removed"], ["multiple", "options_too_few"], ["matrix", "options_too_few"]]) {
    const issue = rejected.data.issues.find((entry) => entry.questionId === questionId && entry.code === code);
    assert.ok(issue, `${questionId}: ${code}`);
    assert.equal(issue.field, "options");
    assert.equal(typeof issue.questionNumber, "number");
  }
  assert.deepEqual((await call(`/admin/surveys/${saved.id}`, "GET", undefined, true)).data, saved);
  assert.deepEqual((await call(`/admin/surveys/${saved.id}/results`, "GET", undefined, true)).data, resultsBefore);
  const brokenReference = structuredClone(saved);
  brokenReference.questions[1].exclusiveOptions = ["missing"];
  brokenReference.questions[1].terminateOptions = ["missing"];
  brokenReference.questions[5].condition = { questionId: "single", value: "missing" };
  const referenceError = await call(`/admin/surveys/${saved.id}`, "PUT", brokenReference, true);
  assert.equal(referenceError.status, 400);
  for (const field of ["exclusiveOptions", "terminateOptions", "condition"])
    assert.ok(referenceError.data.issues.some((issue) => issue.field === field));
  const attempts = await Promise.all(["first writer", "second writer"].map((title) => call(`/admin/surveys/${saved.id}`, "PUT", { ...saved, title }, true)));
  assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 409]);
  assert.equal(attempts.find((attempt) => attempt.status === 409).data.code, "SURVEY_REVISION_CONFLICT");
  const current = attempts.find((attempt) => attempt.status === 200).data;
  assert.equal(current.revision, saved.revision + 1);
  const stale = await call(`/surveys/${saved.id}/submit`, "POST", { answers, definitionVersion: saved.definitionVersion });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "SURVEY_VERSION_CONFLICT");
  const resultsAfter = (await call(`/admin/surveys/${saved.id}/results`, "GET", undefined, true)).data;
  assert.deepEqual(resultsAfter.rows, resultsBefore.rows);
  assert.deepEqual(resultsAfter.summary, resultsBefore.summary);
});
