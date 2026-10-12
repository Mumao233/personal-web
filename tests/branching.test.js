import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visibleQuestions,
  validateSurvey,
  validateAnswers,
} from "../server/validation.js";
test("a hidden prerequisite cannot reveal its dependent question from stale draft answers", () => {
  const survey = {
    questions: [
      { id: "a", type: "single", options: ["yes", "no"] },
      {
        id: "b",
        type: "single",
        options: ["yes", "no"],
        condition: { questionId: "a", value: "yes" },
      },
      { id: "c", type: "text", condition: { questionId: "b", value: "yes" } },
    ],
  };
  assert.deepEqual(
    visibleQuestions(survey, { a: "no", b: "yes" }).map((q) => q.id),
    ["a"],
  );
});
test("invalid condition option is rejected instead of silently skipping a required question", () => {
  assert.throws(
    () =>
      validateSurvey({
        title: "Test",
        questions: [
          { id: "a", title: "A", type: "single", options: ["yes", "no"] },
          {
            id: "b",
            title: "B",
            type: "text",
            condition: { questionId: "a", value: "missing" },
          },
        ],
      }),
    /条件答案/,
  );
});
test("other answer must include text and is retained alongside the selected option", () => {
  const s = {
    questions: [
      {
        id: "a",
        title: "A",
        type: "multiple",
        options: ["A", "B"],
        allowOther: true,
      },
    ],
  };
  assert.throws(() => validateAnswers(s, { a: ["其他"] }), /补充/);
  assert.deepEqual(
    validateAnswers(s, { a: ["A", "其他"], a__other: "A new idea" }),
    { a: ["A", "其他"], a__other: "A new idea" },
  );
});
