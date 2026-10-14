const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const choiceTypes = ["single", "multiple", "rank", "multirank"];
const ruleTypes = ["single", "multiple", "multirank"];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 120 &&
  !["__proto__", "constructor", "prototype"].includes(value) &&
  !Object.prototype.hasOwnProperty.call(Object.prototype, value) &&
  !value.endsWith("__other");
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

export function validateSurvey(survey) {
  if (
    !object(survey) ||
    typeof survey.title !== "string" ||
    !survey.title.trim() ||
    survey.title.length > 200
  )
    throw Error("请填写问卷标题（最多200字）");
  if (
    !Array.isArray(survey.questions) ||
    !survey.questions.length ||
    survey.questions.length > 100
  )
    throw Error("问卷需要1至100个题目");
  if (
    survey.terminationMessage !== undefined &&
    (typeof survey.terminationMessage !== "string" ||
      survey.terminationMessage.length > 2000)
  )
    throw Error("提前结束提示最多2000字");
  const previous = new Map();
  for (const question of survey.questions) {
    if (
      !object(question) ||
      !validId(question.id) ||
      previous.has(question.id) ||
      typeof question.title !== "string" ||
      !question.title.trim() ||
      question.title.length > 1000
    )
      throw Error("题目编号需唯一，且标题不可为空");
    if (![...choiceTypes, "text", "matrix"].includes(question.type))
      throw Error("不支持的题型");
    if (
      question.type !== "text" &&
      (!Array.isArray(question.options) ||
        question.options.length < 2 ||
        question.options.length > 100 ||
        new Set(question.options).size !== question.options.length ||
        question.options.some(
          (option) =>
            typeof option !== "string" ||
            !option.trim() ||
            option.length > 1000,
        ))
    )
      throw Error("选择与排序题需要至少两个不同选项");
    if (question.type === "matrix") {
      if (
        !Array.isArray(question.rows) ||
        question.rows.length < 1 ||
        question.rows.length > 50
      )
        throw Error("矩阵题需要1至50行");
      const rows = new Set();
      for (const row of question.rows) {
        if (
          !object(row) ||
          !validId(row.id) ||
          rows.has(row.id) ||
          typeof row.title !== "string" ||
          !row.title.trim() ||
          row.title.length > 1000
        )
          throw Error("矩阵行编号需唯一，且行标题不可为空");
        rows.add(row.id);
      }
      if (question.allowOther) throw Error("矩阵题不支持“其他”选项");
    }
    if (["text", "rank"].includes(question.type) && question.allowOther)
      throw Error("文字与全排序题不支持“其他”选项");
    for (const [name, supported] of [
      ["terminateOptions", ruleTypes],
      ["exclusiveOptions", ["multiple", "multirank"]],
    ]) {
      const rules = question[name];
      if (
        rules !== undefined &&
        (!Array.isArray(rules) ||
          new Set(rules).size !== rules.length ||
          rules.some(
            (option) =>
              typeof option !== "string" ||
              !optionsFor(question).includes(option),
          ) ||
          (rules.length && !supported.includes(question.type)))
      )
        throw Error(
          name === "terminateOptions"
            ? "提前结束规则需要对应题型中的有效选项"
            : "互斥规则只支持多选或部分排序题中的有效选项",
        );
    }
    if (question.condition?.questionId) {
      const prerequisite = previous.get(question.condition.questionId);
      if (!prerequisite) throw Error("条件必须引用之前的题目");
      if (
        !choiceTypes.includes(prerequisite.type) ||
        !optionsFor(prerequisite).includes(question.condition.value)
      )
        throw Error("条件答案必须是前置题目的有效选项");
    }
    const min = question.min ?? 0,
      max = question.max ?? 0;
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 0 ||
      (max && min > max) ||
      (max && max > optionsFor(question).length) ||
      (min && min > optionsFor(question).length)
    )
      throw Error("选择数量范围无效");
    if (question.type === "single" && (min > 1 || max > 1))
      throw Error("单选题只能选择一个选项");
    if (["text", "matrix"].includes(question.type) && (min || max))
      throw Error("文字和矩阵题不能设置选项数量限制");
    if (
      question.type === "rank" &&
      ((min && min !== question.options.length) ||
        (max && max !== question.options.length))
    )
      throw Error("全排序题必须对全部选项排序，不能限制为部分选项");
    if (["multiple", "multirank"].includes(question.type)) {
      const options = optionsFor(question);
      const exclusives = exclusiveOptionsFor(question);
      const canSingle =
        (!max || max >= 1) &&
        (exclusives.length || (question.terminateOptions || []).length);
      if (
        min > options.filter((option) => !exclusives.includes(option)).length &&
        !canSingle
      )
        throw Error("选择数量限制无法满足，请调整互斥选项或最少数量");
    }
    previous.set(question.id, question);
  }
  if (
    (survey.startsAt && isNaN(Date.parse(survey.startsAt))) ||
    (survey.endsAt && isNaN(Date.parse(survey.endsAt)))
  )
    throw Error("时间格式无效");
  if (
    survey.startsAt &&
    survey.endsAt &&
    new Date(survey.startsAt) >= new Date(survey.endsAt)
  )
    throw Error("截止时间须晚于开始时间");
  return survey;
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
