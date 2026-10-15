import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitOptionLines,
  normalizeSurveyDefinition,
  surveyDefinitionIssues,
} from "../shared/survey-definition.js";
import {
  validateSurvey,
  validateAnswers,
  summarizeSurvey,
  surveyFlow,
  exclusiveOptionsFor,
} from "../server/validation.js";

const choice = (changes = {}) => ({
  id: "q1",
  title: "取餐经历",
  type: "single",
  options: ["遇到过", "没有遇到"],
  ...changes,
});
const survey = (questions = [choice()]) => ({
  title: "隔离测试问卷",
  questions,
});

test("editor LF, CRLF and CR splitting keeps raw blank lines for continued typing", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const raw = ["", "甲", "", "  ", "乙 ", ""].join(newline);
    assert.deepEqual(splitOptionLines(raw), ["", "甲", "", "  ", "乙 ", ""]);
    assert.deepEqual(
      normalizeSurveyDefinition(
        survey([choice({ options: splitOptionLines(raw) })]),
      ).questions[0].options,
      ["甲", "乙 "],
    );
  }
});

test("normalization is immutable and drops only blank options for every choice type and matrix", () => {
  for (const type of ["single", "multiple", "rank", "multirank", "matrix"]) {
    const input = survey([
      choice({
        type,
        options: ["", "  甲 ", "\t", "乙", "　", ""],
        ...(type === "matrix" ? { rows: [{ id: "r1", title: "体验" }] } : {}),
      }),
    ]);
    const before = structuredClone(input);
    const clean = validateSurvey(input);
    assert.deepEqual(clean.questions[0].options, ["  甲 ", "乙"]);
    assert.deepEqual(input, before);
    assert.notEqual(clean.questions[0], input.questions[0]);
  }
  assert.deepEqual(
    validateSurvey(survey([choice({ type: "text", options: ["", "", 42] })]))
      .questions[0].options,
    ["", "", 42],
  );
});

test("structured validation collects exact duplicates, near duplicates, malformed, count and length errors", () => {
  const questions = [
    choice({ id: "duplicate", options: ["没有遇到", "没有遇到", ""] }),
    choice({ id: "whitespace", options: ["没有遇到", " 没有遇到 "] }),
    choice({ id: "few", options: ["", "唯一", "   "] }),
    choice({ id: "long", options: ["甲", "长".repeat(1001)] }),
    choice({
      id: "many",
      options: Array.from({ length: 101 }, (_, index) => `选项${index}`),
    }),
    choice({ id: "malformed", options: ["甲", null, 2] }),
    choice({
      id: "matrix",
      type: "matrix",
      options: ["同意", "同意"],
      rows: [{ id: "r", title: "体验" }],
    }),
    choice({ id: "text", type: "text", options: [] }),
  ];
  const issues = surveyDefinitionIssues(survey(questions));
  for (const [id, code] of [
    ["duplicate", "option_duplicate"],
    ["whitespace", "option_whitespace_duplicate"],
    ["few", "options_too_few"],
    ["long", "option_too_long"],
    ["many", "options_too_many"],
    ["malformed", "option_format"],
    ["matrix", "option_duplicate"],
  ]) {
    const issue = issues.find(
      (item) => item.questionId === id && item.code === code,
    );
    assert.ok(issue, `${id} ${code}`);
    assert.equal(
      issue.questionNumber,
      questions.findIndex((question) => question.id === id) + 1,
    );
    assert.equal(issue.questionTitle, "取餐经历");
    assert.equal(issue.field, "options");
  }
  assert.match(
    issues.find((item) => item.questionId === "matrix").message,
    /第7题「取餐经历」.*矩阵列选项“同意”重复/,
  );
  assert.equal(
    issues.some((item) => item.questionId === "text"),
    false,
  );
  assert.throws(
    () => validateSurvey(survey(questions)),
    (error) =>
      error.code === "SURVEY_VALIDATION_FAILED" &&
      assert.deepEqual(error.issues, issues) === undefined,
  );
  assert.deepEqual(questions[0].options, ["没有遇到", "没有遇到", ""]);
});

test("all shared schema checks tolerate malformed JSON and return actionable issues", () => {
  for (const value of [
    null,
    [],
    {},
    survey([null, 4]),
    survey([choice({ type: "matrix", rows: [null], options: null })]),
    survey([
      choice({ condition: 3, exclusiveOptions: {}, terminateOptions: {} }),
    ]),
  ])
    assert.ok(surveyDefinitionIssues(value).length);
});

test("option normalization preserves exact branching, exclusion, termination references and statistics", () => {
  const original = survey([
    choice({
      id: "gate",
      type: "multiple",
      options: [" 甲 ", "乙", "以上都无"],
      exclusiveOptions: ["以上都无"],
      terminateOptions: ["乙"],
    }),
    choice({
      id: "dependent",
      type: "text",
      condition: { questionId: "gate", value: " 甲 " },
    }),
  ]);
  const answers = { gate: [" 甲 "], dependent: "保留" };
  const raw = structuredClone(original);
  raw.questions[0].options = ["", " 甲 ", "\t", "乙", "以上都无", ""];
  const clean = validateSurvey(raw);
  assert.deepEqual(clean, original);
  assert.deepEqual(validateAnswers(clean, answers), answers);
  assert.deepEqual(
    summarizeSurvey(clean, [{ answers }]),
    summarizeSurvey(original, [{ answers }]),
  );
  assert.deepEqual(
    surveyFlow(clean, answers).questions.map((question) => question.id),
    ["gate", "dependent"],
  );
  assert.equal(surveyFlow(clean, { gate: ["乙"] }).termination.option, "乙");
  assert.deepEqual(exclusiveOptionsFor(clean.questions[0]), ["以上都无"]);
  const broken = structuredClone(clean);
  broken.questions[0].options = ["甲", "丙"];
  const issues = surveyDefinitionIssues(broken);
  assert.ok(
    issues.some(
      (issue) =>
        issue.questionId === "dependent" &&
        issue.field === "condition" &&
        issue.code === "condition_value",
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "exclusiveOptions" && issue.code === "rule_reference",
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.field === "terminateOptions" && issue.code === "rule_reference",
    ),
  );
});

test("history guard rejects destructive remapping without rewriting snapshots and permits safe additions/reordering", () => {
  const previousSurvey = survey([
    choice({ options: [" 甲 ", "乙", "未选"] }),
    choice({
      id: "matrix",
      type: "matrix",
      options: ["是", "否"],
      rows: [
        { id: "r1", title: "体验" },
        { id: "r2", title: "未答" },
      ],
    }),
    choice({
      id: "other",
      type: "multiple",
      options: ["甲", "乙"],
      allowOther: true,
    }),
  ]);
  const submissions = [
    {
      questions: structuredClone(previousSurvey.questions),
      answers: {
        q1: " 甲 ",
        matrix: { r1: "是" },
        other: ["其他"],
        other__other: "补充",
      },
    },
  ];
  const snapshot = structuredClone(submissions);
  const unsafe = structuredClone(previousSurvey);
  unsafe.questions[0].options = ["甲", "乙"];
  unsafe.questions[1].rows = [unsafe.questions[1].rows[1]];
  unsafe.questions[2].allowOther = false;
  const issues = surveyDefinitionIssues(unsafe, {
    previousSurvey,
    submissions,
  });
  for (const code of [
    "historical_option_removed",
    "historical_row_removed",
    "historical_other_removed",
  ])
    assert.ok(
      issues.some((issue) => issue.code === code),
      code,
    );
  for (const change of [
    { questions: previousSurvey.questions.slice(1) },
    {
      questions: previousSurvey.questions.map((question) =>
        question.id === "q1" ? { ...question, type: "rank" } : question,
      ),
    },
  ])
    assert.ok(
      surveyDefinitionIssues(
        { ...previousSurvey, ...change },
        { previousSurvey, submissions },
      ).some((issue) => issue.code.startsWith("historical_")),
    );
  const removed = surveyDefinitionIssues(
    { ...previousSurvey, questions: previousSurvey.questions.slice(1) },
    { previousSurvey, submissions },
  ).find((issue) => issue.code === "historical_question_removed");
  assert.equal(removed.questionId, "q1");
  assert.equal(removed.questionNumber, null);
  assert.equal(removed.formerQuestionNumber, 1);
  assert.match(removed.message, /^原第1题「取餐经历」（ID：q1）已从当前编辑稿删除/);
  const safe = structuredClone(previousSurvey);
  safe.questions[0].options = ["乙", "", " 甲 ", "新增"];
  safe.questions[0].title = "修改标题";
  safe.questions[1].rows = [safe.questions[1].rows[0]];
  assert.deepEqual(
    surveyDefinitionIssues(safe, { previousSurvey, submissions }),
    [],
  );
  assert.deepEqual(submissions, snapshot);
});

test("legacy unmapped answers do not block unrelated edits but newly lost mappings are rejected", () => {
  const previousSurvey = survey([choice({ options: ["甲", "乙"] })]);
  const submissions = [
    { answers: { q1: "旧版删除项" } },
    { answers: { q1: "乙" } },
  ];
  assert.deepEqual(
    surveyDefinitionIssues(previousSurvey, { previousSurvey, submissions }),
    [],
  );
  const modified = survey([choice({ options: ["甲", "丙"] })]);
  assert.equal(
    surveyDefinitionIssues(modified, { previousSurvey, submissions }).filter(
      (issue) => issue.code === "historical_option_removed",
    ).length,
    1,
  );
});
