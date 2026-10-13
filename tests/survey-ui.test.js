import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { answerError, surveyFlow } from "../server/validation.js";

let vite, QuestionInput, pruneSurveyAnswers, toggleSurveyOption, surveySections;
before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ QuestionInput, pruneSurveyAnswers, toggleSurveyOption, surveySections } =
    await vite.ssrLoadModule("/src/survey.jsx"));
});
after(async () => {
  await vite?.close();
});

const renderQuestion = (q, value) =>
  renderToStaticMarkup(
    React.createElement(QuestionInput, { q, value, onChange() {} }),
  );
const matrix = {
  id: "likert",
  title: "学习感受",
  type: "matrix",
  rows: [
    { id: "interest", title: "学习内容有趣" },
    { id: "useful", title: "所学知识有帮助" },
  ],
  options: ["不同意", "一般", "同意"],
};

test("matrix rows have independent native radio groups and complete accessible labels", () => {
  const html = renderQuestion(matrix, { interest: "同意" });
  assert.equal((html.match(/type="radio"/g) || []).length, 6);
  assert.equal((html.match(/name="likert-row-interest"/g) || []).length, 3);
  assert.equal((html.match(/name="likert-row-useful"/g) || []).length, 3);
  assert.equal((html.match(/checked=""/g) || []).length, 1);
  for (const row of matrix.rows) {
    for (const option of matrix.options) {
      assert.ok(html.includes(`aria-label="${row.title}：${option}"`));
    }
  }
  assert.equal((html.match(/class="matrix-mobile-label"/g) || []).length, 6);
  assert.ok(html.includes('aria-label="清除“学习内容有趣”的回答"'));
  assert.ok(html.includes('aria-label="清除“所学知识有帮助”的回答"'));
  assert.doesNotMatch(
    renderQuestion({ ...matrix, required: true }, {}),
    /matrix-clear/,
  );
});

test("required matrix validation checks every row while optional rows may stay blank", () => {
  assert.equal(answerError(matrix, { likert: { interest: "同意" } }), "");
  assert.match(
    answerError(
      { ...matrix, required: true },
      { likert: { interest: "同意" } },
    ),
    /所学知识有帮助/,
  );
  assert.equal(
    answerError(
      { ...matrix, required: true },
      { likert: { interest: "同意", useful: "一般" } },
    ),
    "",
  );
});

test("legacy none-of-the-above replaces other answers and is exempt from the minimum", () => {
  for (const type of ["multiple", "multirank"]) {
    const q = {
      id: "choice",
      title: "选择",
      type,
      options: ["甲", "乙", "以上都无"],
      min: 2,
      required: true,
    };
    const none = toggleSurveyOption(q, ["甲", "乙"], "以上都无");
    assert.deepEqual(none, ["以上都无"]);
    assert.equal(answerError(q, { choice: none }), "");
    const ordinary = toggleSurveyOption(q, none, "甲");
    assert.deepEqual(ordinary, ["甲"]);
    assert.match(answerError(q, { choice: ordinary }), /数量/);
    assert.deepEqual(toggleSurveyOption(q, none, "以上都无"), []);
    assert.match(renderQuestion(q, none), /单独选择/);
  }
});

test("configured exclusive options behave like the legacy none choice", () => {
  const q = {
    id: "choice",
    title: "选择",
    type: "multiple",
    options: ["甲", "乙", "不适用"],
    exclusiveOptions: ["不适用"],
    min: 2,
  };
  assert.deepEqual(toggleSurveyOption(q, ["甲", "乙"], "不适用"), ["不适用"]);
  assert.deepEqual(toggleSurveyOption(q, ["不适用"], "乙"), ["乙"]);
  assert.equal(answerError(q, { choice: ["不适用"] }), "");
});

test("ending a survey removes downstream answers and other text before switching back", () => {
  const survey = {
    questions: [
      {
        id: "gate",
        title: "资格",
        type: "single",
        options: ["继续", "结束"],
        terminateOptions: ["结束"],
      },
      {
        id: "follow",
        title: "后续",
        type: "multiple",
        options: ["甲", "乙"],
        allowOther: true,
      },
      {
        id: "nested",
        title: "附加",
        type: "text",
        condition: { questionId: "follow", value: "其他" },
      },
    ],
  };
  const ended = pruneSurveyAnswers(survey, {
    gate: "结束",
    follow: ["其他"],
    follow__other: "旧补充",
    nested: "旧答案",
  });
  assert.deepEqual(ended, { gate: "结束" });
  assert.equal(surveyFlow(survey, ended).termination.questionId, "gate");
  const resumed = pruneSurveyAnswers(survey, { ...ended, gate: "继续" });
  assert.deepEqual(resumed, { gate: "继续" });
  assert.equal(surveyFlow(survey, resumed).termination, null);
});

test("hidden prerequisites and deselected other options do not retain old draft values", () => {
  const survey = {
    questions: [
      { id: "gate", title: "开关", type: "single", options: ["是", "否"] },
      {
        id: "conditional",
        title: "条件题",
        type: "multiple",
        options: ["甲", "乙"],
        allowOther: true,
        condition: { questionId: "gate", value: "是" },
      },
      {
        id: "dependent",
        title: "后续",
        type: "text",
        condition: { questionId: "conditional", value: "其他" },
      },
    ],
  };
  assert.deepEqual(
    pruneSurveyAnswers(survey, {
      gate: "否",
      conditional: ["其他"],
      conditional__other: "旧补充",
      dependent: "旧值",
    }),
    { gate: "否" },
  );
  assert.deepEqual(
    pruneSurveyAnswers(survey, {
      gate: "是",
      conditional: ["甲"],
      conditional__other: "旧补充",
      dependent: "旧值",
    }),
    { gate: "是", conditional: ["甲"] },
  );
  assert.deepEqual(pruneSurveyAnswers(survey, "malformed draft"), {});
});

test("a valid end option takes effect even below the usual selection minimum", () => {
  for (const type of ["multiple", "multirank"]) {
    const question = {
      id: "gate",
      title: "选择",
      type,
      options: ["甲", "乙", "结束"],
      terminateOptions: ["结束"],
      min: 2,
    };
    const survey = {
      questions: [question, { id: "later", title: "后续", type: "text" }],
    };
    const selected = toggleSurveyOption(question, [], "结束");
    assert.equal(answerError(question, { gate: selected }), "");
    assert.deepEqual(
      pruneSurveyAnswers(survey, { gate: selected, later: "旧答案" }),
      { gate: ["结束"] },
    );
  }
});

test("nonadjacent sections with the same name remain separate in the authored order", () => {
  const groups = surveySections([
    { id: "a", section: "A" },
    { id: "a2", section: "A" },
    { id: "b", section: "B" },
    { id: "c", section: "A" },
  ]);
  assert.deepEqual(
    groups.map((group) => group.title),
    ["A", "B", "A"],
  );
  assert.deepEqual(
    groups.map((group) => group.questions.map((q) => q.id)),
    [["a", "a2"], ["b"], ["c"]],
  );
});
