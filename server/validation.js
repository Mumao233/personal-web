import { normalizeSurveyDefinition, surveyDefinitionIssues } from "../shared/survey-definition.js";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const choiceTypes = ["single", "multiple", "rank", "multirank"];
const ruleTypes = ["single", "multiple", "multirank"];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const optionsFor = (question) => [
  ...new Set([
    ...(question.options || []),
    ...(question.allowOther ? ["其他"] : []),
  ]),
];

export function exclusiveOptionsFor(question) {
  if (!["multiple", "multirank"].includes(question.type)) return [];
  const options = optionsFor(question);
  return [
    ...new Set([
      ...(question.exclusiveOptions || []).filter((option) =>
        options.includes(option),
      ),
      ...(options.includes("以上都无") ? ["以上都无"] : []),
    ]),
  ];
}

function questionAnswer(question, answers) {
  const value =
    answers && own(answers, question.id) ? answers[question.id] : undefined;
  const missing =
    value == null || value === "" || (Array.isArray(value) && !value.length);
  if (question.type === "matrix") {
    if (value == null || value === "") {
      if (question.required)
        throw Error(`请完成矩阵题的每一行：${question.title}`);
      return null;
    }
    if (!object(value)) throw Error(`矩阵答案格式无效：${question.title}`);
    const rowIds = new Set((question.rows || []).map((row) => row.id));
    if (Object.keys(value).some((id) => !rowIds.has(id)))
      throw Error(`矩阵答案包含无效行：${question.title}`);
    const clean = {};
    for (const row of question.rows || []) {
      const choice = own(value, row.id) ? value[row.id] : undefined;
      if (choice === undefined || choice === "" || choice === null) {
        if (question.required)
          throw Error(`请回答：${question.title} · ${row.title}`);
      } else if (
        typeof choice !== "string" ||
        !question.options.includes(choice)
      ) {
        throw Error(`矩阵选项无效：${question.title} · ${row.title}`);
      } else clean[row.id] = choice;
    }
    return Object.keys(clean).length ? { value: clean } : null;
  }
  if (missing) {
    if (question.required) throw Error(`请回答：${question.title}`);
    return null;
  }
  if (question.type === "text") {
    if (typeof value !== "string" || value.length > 10000)
      throw Error("文字回答最多10000字");
    if (question.required && !value.trim())
      throw Error(`请回答：${question.title}`);
    return { value };
  }
  const values = question.type === "single" ? [value] : value;
  if (
    !choiceTypes.includes(question.type) ||
    !Array.isArray(values) ||
    values.some((option) => !optionsFor(question).includes(option)) ||
    new Set(values).size !== values.length
  )
    throw Error(`选项无效：${question.title}`);
  const exclusive = values.filter((option) =>
    exclusiveOptionsFor(question).includes(option),
  );
  if (exclusive.length && values.length !== 1)
    throw Error(`互斥选项不能与其他选项同时选择：${question.title}`);
  let other;
  if (question.allowOther && values.includes("其他")) {
    other = own(answers, question.id + "__other")
      ? answers[question.id + "__other"]
      : undefined;
    if (typeof other !== "string" || !other.trim() || other.length > 10000)
      throw Error(`请补充“其他”的内容：${question.title}`);
    other = other.trim();
  }
  if (question.type === "rank" && values.length !== question.options.length)
    throw Error(`请对全部选项排序：${question.title}`);
  const terminates =
    ruleTypes.includes(question.type) &&
    values.some((option) => (question.terminateOptions || []).includes(option));
  if (
    (!exclusive.length &&
      !terminates &&
      question.min &&
      values.length < question.min) ||
    (question.max && values.length > question.max)
  )
    throw Error(`选择数量不符合要求：${question.title}`);
  return {
    value: question.type === "single" ? value : [...values],
    ...(other !== undefined ? { other } : {}),
  };
}

export function answerError(question, answers) {
  try {
    questionAnswer(question, answers || {});
    return "";
  } catch (error) {
    return error.message;
  }
}

export function surveyFlow(survey, answers = {}) {
  const shown = new Set();
  const questions = [];
  let termination = null;
  for (const question of survey.questions || []) {
    const condition = question.condition;
    const conditionAnswer =
      condition?.questionId && own(answers, condition.questionId)
        ? answers[condition.questionId]
        : undefined;
    const visible =
      !condition?.questionId ||
      (shown.has(condition.questionId) &&
        (Array.isArray(conditionAnswer)
          ? conditionAnswer
          : [conditionAnswer]
        ).includes(condition.value));
    if (!visible) continue;
    shown.add(question.id);
    questions.push(question);
    const selected =
      own(answers, question.id) && Array.isArray(answers?.[question.id])
        ? answers[question.id]
        : [own(answers, question.id) ? answers[question.id] : undefined];
    const endChoice = (question.terminateOptions || []).find((option) =>
      selected.includes(option),
    );
    if (
      ruleTypes.includes(question.type) &&
      endChoice !== undefined &&
      !answerError(question, answers)
    ) {
      termination = {
        questionId: question.id,
        questionTitle: question.title,
        option: endChoice,
      };
      break;
    }
  }
  return { questions, termination };
}

export function visibleQuestions(survey, answers) {
  return surveyFlow(survey, answers).questions;
}

// Completion measures valid required answers, never the section currently open.
// Matrix rows are individual items so a partially answered matrix is represented.
export function surveyAnswerProgress(survey, answers = {}) {
  const { questions, termination } = surveyFlow(survey, answers);
  let total = 0;
  let answered = 0;
  for (const question of questions) {
    if (!question.required) continue;
    if (question.type === "matrix") {
      for (const row of question.rows || []) {
        total++;
        const value = answers?.[question.id];
        if (object(value) && Object.keys(value).every((id) => question.rows.some((r) => r.id === id)) && own(value, row.id) &&
            !answerError({ ...question, rows: [row] }, {
              [question.id]: { [row.id]: value[row.id] },
            })) answered++;
      }
    } else {
      total++;
      if (!answerError(question, answers)) answered++;
    }
  }
  return { total, answered, percent: total ? Math.floor(answered / total * 100) : 0, terminated: Boolean(termination) };
}

export function validateSurvey(survey, context) {
  const normalized = normalizeSurveyDefinition(survey);
  const issues = surveyDefinitionIssues(normalized, context);
  if (issues.length)
    throw Object.assign(Error(issues[0].message), {
      status: 400,
      code: "SURVEY_VALIDATION_FAILED",
      issues,
    });
  return normalized;
}

export function validateAnswers(survey, answers) {
  if (!object(answers)) throw Error("问卷答案格式无效");
  const clean = {};
  for (const question of surveyFlow(survey, answers).questions) {
    const result = questionAnswer(question, answers);
    if (!result) continue;
    clean[question.id] = result.value;
    if (result.other !== undefined)
      clean[question.id + "__other"] = result.other;
  }
  return clean;
}

export function summarizeSurvey(survey, submissions) {
  return (survey.questions || []).map((question) => {
    const options = optionsFor(question);
    const result = {
      id: question.id,
      title: question.title,
      type: question.type,
      counts: ["text", "matrix"].includes(question.type)
        ? null
        : Object.fromEntries(
            options.map((option) => [
              option,
              submissions.filter((row) =>
                Array.isArray(row.answers?.[question.id])
                  ? row.answers[question.id].includes(option)
                  : row.answers?.[question.id] === option,
              ).length,
            ]),
          ),
      rank: question.type.includes("rank")
        ? Object.fromEntries(
            options.map((option) => {
              const positions = submissions
                .filter(
                  (row) =>
                    Array.isArray(row.answers?.[question.id]) &&
                    row.answers[question.id].includes(option),
                )
                .map((row) => row.answers[question.id].indexOf(option) + 1);
              return [
                option,
                positions.length
                  ? Number(
                      (
                        positions.reduce((total, value) => total + value, 0) /
                        positions.length
                      ).toFixed(2),
                    )
                  : null,
              ];
            }),
          )
        : null,
      answered: submissions.filter((row) => row.answers?.[question.id] != null)
        .length,
    };
    if (question.type === "matrix")
      result.matrix = (question.rows || []).map((matrixRow) => ({
        id: matrixRow.id,
        title: matrixRow.title,
        counts: Object.fromEntries(
          options.map((option) => [
            option,
            submissions.filter(
              (row) => row.answers?.[question.id]?.[matrixRow.id] === option,
            ).length,
          ]),
        ),
        answered: submissions.filter((row) =>
          options.includes(row.answers?.[question.id]?.[matrixRow.id]),
        ).length,
      }));
    return result;
  });
}

export function surveyCompletionCounts(submissions) {
  return {
    completed: submissions.filter((row) => row.completion !== "terminated")
      .length,
    terminated: submissions.filter((row) => row.completion === "terminated")
      .length,
  };
}
