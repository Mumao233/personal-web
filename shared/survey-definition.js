// Definition rules shared by the editor and the server. Answer values and rule
// references use exact option text, so normalization must never trim or dedupe it.
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const choiceTypes = ["single", "multiple", "rank", "multirank"];
const optionTypes = [...choiceTypes, "matrix"];
const ruleTypes = ["single", "multiple", "multirank"];
const validId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 120 &&
  !["__proto__", "constructor", "prototype"].includes(value) &&
  !own(Object.prototype, value) &&
  !value.endsWith("__other");
const optionsFor = (question) => [
  ...new Set([
    ...(Array.isArray(question.options)
      ? question.options.filter((option) => typeof option === "string")
      : []),
    ...(question.allowOther ? ["其他"] : []),
  ]),
];

// Keep empty entries here: the editor must preserve a freshly typed newline.
export const splitOptionLines = (text) =>
  String(text ?? "").split(/\r\n|\n|\r/);

export function normalizeSurveyDefinition(survey) {
  const normalized = structuredClone(survey);
  if (!object(normalized) || !Array.isArray(normalized.questions))
    return normalized;
  for (const question of normalized.questions) {
    if (
      object(question) &&
      optionTypes.includes(question.type) &&
      Array.isArray(question.options)
    )
      question.options = question.options.filter(
        (option) => typeof option !== "string" || option.trim() !== "",
      );
  }
  return normalized;
}

function issueFor(question, index, field, code, reason, extra = {}) {
  const title = typeof question?.title === "string" ? question.title : "";
  return {
    questionId: typeof question?.id === "string" ? question.id : null,
    questionNumber: index === null ? null : index + 1,
    questionTitle: title,
    field,
    code,
    message:
      index === null
        ? reason
        : `第${index + 1}题${title ? `「${title}」` : ""}${reason}`,
    ...extra,
  };
}

// Context is optional in the browser. Only the server has authoritative saved
// submissions; it checks these under the same write lock as the revision check.
export function surveyDefinitionIssues(input, context = {}) {
  const survey = normalizeSurveyDefinition(input);
  const issues = [];
  const addSurvey = (field, code, reason) =>
    issues.push(issueFor(null, null, field, code, reason));
  if (!object(survey)) {
    addSurvey("survey", "survey_format", "问卷格式无效，请重新载入问卷。");
    return issues;
  }
  if (
    typeof survey.title !== "string" ||
    !survey.title.trim() ||
    survey.title.length > 200
  )
    addSurvey("title", "survey_title", "请填写问卷标题（最多200字）。");
  if (
    !Array.isArray(survey.questions) ||
    !survey.questions.length ||
    survey.questions.length > 100
  )
    addSurvey("questions", "question_count", "问卷需要1至100个题目。");
  if (
    survey.terminationMessage !== undefined &&
    (typeof survey.terminationMessage !== "string" ||
      survey.terminationMessage.length > 2000)
  )
    addSurvey(
      "terminationMessage",
      "termination_message",
      "提前结束提示最多2000字。",
    );
  const previous = new Map();
  for (const [index, question] of (Array.isArray(survey.questions)
    ? survey.questions
    : []
  ).entries()) {
    const add = (field, code, reason, extra) =>
      issues.push(issueFor(question, index, field, code, reason, extra));
    if (!object(question)) {
      add("questions", "question_format", "格式无效，请重新创建此题。");
      continue;
    }
    if (!validId(question.id))
      add("id", "question_id", "的稳定题目ID无效，请重新创建此题。");
    else if (previous.has(question.id))
      add(
        "id",
        "question_id_duplicate",
        `的稳定题目ID“${question.id}”重复，请重新创建重复题目。`,
      );
    if (typeof question.title !== "string" || !question.title.trim())
      add("title", "question_title_empty", "的标题不可为空，请填写标题。");
    else if (question.title.length > 1000)
      add("title", "question_title_length", "的标题超过1000字，请缩短标题。");
    if (![...optionTypes, "text"].includes(question.type))
      add("type", "question_type", "使用了不支持的题型，请重新选择题型。");
    if (optionTypes.includes(question.type)) {
      const label = question.type === "matrix" ? "矩阵列选项" : "选项";
      if (!Array.isArray(question.options))
        add(
          "options",
          "options_format",
          `的${label}格式无效，请每行输入一个文字选项。`,
        );
      else {
        const validOptions = question.options.filter(
          (option) => typeof option === "string",
        );
        if (validOptions.length < 2)
          add(
            "options",
            "options_too_few",
            `的${label}忽略空白行后仅剩${validOptions.length}项，至少需要2个有效选项。`,
          );
        if (question.options.length > 100)
          add(
            "options",
            "options_too_many",
            `的${label}共有${question.options.length}项，最多支持100项，请减少选项。`,
          );
        const seen = new Map();
        for (const [optionIndex, option] of question.options.entries()) {
          if (typeof option !== "string") {
            add(
              "options",
              "option_format",
              `的第${optionIndex + 1}个${label}不是文字，请改为文字选项。`,
              { optionIndex },
            );
            continue;
          }
          if (option.length > 1000)
            add(
              "options",
              "option_too_long",
              `的第${optionIndex + 1}个${label}超过1000字，请缩短该选项。`,
              { optionIndex },
            );
          const key = option.trim();
          if (seen.has(key)) {
            const first = seen.get(key);
            add(
              "options",
              first === option
                ? "option_duplicate"
                : "option_whitespace_duplicate",
              first === option
                ? `的${label}“${option}”重复，请修改或删除其中一项。`
                : `的${label}“${first}”与“${option}”仅首尾空白不同，请明确区分或删除其中一项；系统不会自动修改选项文字。`,
              { optionIndex, option },
            );
          } else seen.set(key, option);
        }
        if (
          question.allowOther &&
          validOptions.some((option) => option.trim() === "其他")
        )
          add(
            "options",
            "other_option_duplicate",
            `的${label}包含“其他”，与自动添加的“其他”选项重复，请关闭自动“其他”或移除这一普通选项。`,
          );
      }
    }
    if (question.type === "matrix") {
      if (
        !Array.isArray(question.rows) ||
        question.rows.length < 1 ||
        question.rows.length > 50
      )
        add("rows", "matrix_row_count", "的矩阵需要1至50行，请调整行数。");
      const rows = new Set();
      for (const [rowIndex, row] of (Array.isArray(question.rows)
        ? question.rows
        : []
      ).entries()) {
        if (!object(row) || !validId(row.id))
          add(
            "rows",
            "matrix_row_id",
            `的矩阵第${rowIndex + 1}行ID无效，请重新创建此行。`,
            { rowIndex },
          );
        else if (rows.has(row.id))
          add(
            "rows",
            "matrix_row_id_duplicate",
            `的矩阵第${rowIndex + 1}行ID重复，请重新创建重复行。`,
            { rowIndex },
          );
        if (typeof row?.title !== "string" || !row.title.trim())
          add(
            "rows",
            "matrix_row_title",
            `的矩阵第${rowIndex + 1}行标题不可为空。`,
            { rowIndex },
          );
        else if (row.title.length > 1000)
          add(
            "rows",
            "matrix_row_title_length",
            `的矩阵第${rowIndex + 1}行标题超过1000字，请缩短标题。`,
            { rowIndex },
          );
        if (object(row)) rows.add(row.id);
      }
      if (question.allowOther)
        add(
          "allowOther",
          "matrix_other",
          "的矩阵题不支持“其他”选项，请关闭此设置。",
        );
    }
    if (["text", "rank"].includes(question.type) && question.allowOther)
      add(
        "allowOther",
        "unsupported_other",
        "的文字与全排序题不支持“其他”选项，请关闭此设置。",
      );
    for (const [field, supported, label] of [
      ["terminateOptions", ruleTypes, "提前结束"],
      ["exclusiveOptions", ["multiple", "multirank"], "互斥"],
    ]) {
      const rules = question[field];
      if (rules === undefined) continue;
      if (!Array.isArray(rules))
        add(
          field,
          "rule_format",
          `的${label}规则格式无效，请重新选择规则选项。`,
        );
      else {
        if (rules.length && !supported.includes(question.type))
          add(
            field,
            "rule_type",
            `的当前题型不支持${label}规则，请移除该规则或调整题型。`,
          );
        if (new Set(rules).size !== rules.length)
          add(
            field,
            "rule_duplicate",
            `的${label}规则包含重复选项，请移除重复规则。`,
          );
        for (const option of rules)
          if (
            typeof option !== "string" ||
            !optionsFor(question).includes(option)
          )
            add(
              field,
              "rule_reference",
              `的${label}规则引用了不存在的选项“${String(option)}”，请修改规则或恢复原选项文字。`,
            );
      }
    }
    if (question.condition != null) {
      const condition = question.condition;
      if (!object(condition))
        add(
          "condition",
          "condition_format",
          "的跳题条件格式无效，请重新设置条件。",
        );
      else if (condition.questionId) {
        const prerequisite = previous.get(condition.questionId);
        if (!prerequisite)
          add(
            "condition",
            "condition_question",
            `的条件必须引用之前的题目；找不到前置题目“${condition.questionId}”，请重新设置条件。`,
          );
        else if (
          !choiceTypes.includes(prerequisite.type) ||
          !optionsFor(prerequisite).includes(condition.value)
        )
          add(
            "condition",
            "condition_value",
            `的条件答案“${String(condition.value)}”必须是前置题目「${prerequisite.title}」的有效选项，请修改条件或恢复原选项文字。`,
          );
      } else if (condition.value)
        add(
          "condition",
          "condition_question",
          "的跳题条件未指定前置题目，请补全条件或清空条件值。",
        );
    }
    const min = question.min ?? 0,
      max = question.max ?? 0;
    const options = optionsFor(question);
    if (!Number.isInteger(min) || min < 0 || (min && min > options.length))
      add(
        "min",
        "minimum_invalid",
        "的最少选择数量无效，必须是0至有效选项数之间的整数。",
      );
    if (!Number.isInteger(max) || max < 0 || (max && max > options.length))
      add(
        "max",
        "maximum_invalid",
        "的最多选择数量无效，必须是0至有效选项数之间的整数。",
      );
    if (max && min > max)
      add(
        "max",
        "range_invalid",
        "的最多选择数量小于最少选择数量，请调整范围。",
      );
    if (question.type === "single" && (min > 1 || max > 1))
      add(
        min > 1 ? "min" : "max",
        "single_count",
        "是单选题，只能选择一个选项。",
      );
    if (["text", "matrix"].includes(question.type) && (min || max))
      add(
        min ? "min" : "max",
        "unsupported_count",
        "的文字和矩阵题不能设置选项数量限制，请清空限制。",
      );
    if (
      question.type === "rank" &&
      ((min && min !== question.options?.length) ||
        (max && max !== question.options?.length))
    )
      add(
        min && min !== question.options?.length ? "min" : "max",
        "rank_count",
        "是全排序题，必须对全部选项排序，不能限制为部分选项。",
      );
    if (["multiple", "multirank"].includes(question.type)) {
      const exclusives = [
        ...new Set([
          ...(Array.isArray(question.exclusiveOptions)
            ? question.exclusiveOptions.filter((option) =>
                options.includes(option),
              )
            : []),
          ...(options.includes("以上都无") ? ["以上都无"] : []),
        ]),
      ];
      const canSingle =
        (!max || max >= 1) &&
        (exclusives.length ||
          (Array.isArray(question.terminateOptions) &&
            question.terminateOptions.length));
      if (
        min > options.filter((option) => !exclusives.includes(option)).length &&
        !canSingle
      )
        add(
          "min",
          "range_unreachable",
          "的选择数量限制无法满足，请调整互斥选项或最少数量。",
        );
    }
    previous.set(question.id, question);
  }
  for (const field of ["startsAt", "endsAt"])
    if (
      survey[field] &&
      (typeof survey[field] !== "string" || isNaN(Date.parse(survey[field])))
    )
      addSurvey(
        field,
        "date_format",
        `${field === "startsAt" ? "开始" : "截止"}时间格式无效。`,
      );
  if (
    survey.startsAt &&
    survey.endsAt &&
    new Date(survey.startsAt) >= new Date(survey.endsAt)
  )
    addSurvey("endsAt", "date_order", "截止时间须晚于开始时间。");
  return [...issues, ...historicalAnswerIssues(survey, context)];
}

function historicalAnswerIssues(
  survey,
  { previousSurvey, submissions = [] } = {},
) {
  if (
    !Array.isArray(previousSurvey?.questions) ||
    !Array.isArray(survey.questions) ||
    !Array.isArray(submissions)
  )
    return [];
  const issues = [],
    seen = new Set();
  const current = new Map(
    survey.questions.flatMap((question, index) =>
      object(question) ? [[question.id, { question, index }]] : [],
    ),
  );
  const add = (question, index, field, code, reason, extra) => {
    const key = JSON.stringify([question.id, field, code, reason]);
    if (!seen.has(key)) {
      issues.push(issueFor(question, index, field, code, reason, extra));
      seen.add(key);
    }
  };
  for (const [oldIndex, old] of previousSurvey.questions.entries()) {
    if (!object(old)) continue;
    const records = submissions.filter(
      (row) =>
        object(row.answers) &&
        own(row.answers, old.id) &&
        row.answers[old.id] != null,
    );
    if (!records.length) continue;
    const next = current.get(old.id);
    if (!next) {
      add(
        old,
        null,
        "questions",
        "historical_question_removed",
        `原第${oldIndex + 1}题「${old.title}」（ID：${old.id}）已从当前编辑稿删除，但已有历史答卷，不能删除或更换题目ID；请恢复此题，或新建另一份问卷。`,
        { formerQuestionNumber: oldIndex + 1 },
      );
      continue;
    }
    const { question, index } = next;
    if (question.type !== old.type) {
      add(
        question,
        index,
        "type",
        "historical_type_changed",
        "已有历史答卷，改变题型会导致答案无法安全对应；请恢复原题型，或新建另一份问卷。",
      );
      continue;
    }
    if (
      old.allowOther &&
      !question.allowOther &&
      records.some((row) => own(row.answers, old.id + "__other"))
    )
      add(
        question,
        index,
        "allowOther",
        "historical_other_removed",
        "已有“其他”的补充回答，不能关闭“其他”选项；请保留原设置，或新建另一份问卷。",
      );
    if (!optionTypes.includes(old.type)) continue;
    const oldOptions = optionsFor(old),
      nextOptions = optionsFor(question);
    const answered = new Set();
    for (const row of records) {
      const value = row.answers[old.id];
      if (old.type === "matrix" && object(value)) {
        for (const [rowId, choice] of Object.entries(value)) {
          answered.add(choice);
          const oldRow =
            Array.isArray(old.rows) &&
            old.rows.find((entry) => entry?.id === rowId);
          if (
            oldRow &&
            !(
              Array.isArray(question.rows) &&
              question.rows.some((entry) => entry?.id === rowId)
            )
          )
            add(
              question,
              index,
              "rows",
              "historical_row_removed",
              `的矩阵行「${oldRow.title}」（ID：${rowId}）已有历史答案，不能删除或更换行ID；请恢复此行，或新建另一份问卷。`,
            );
        }
      } else
        for (const choice of Array.isArray(value) ? value : [value])
          answered.add(choice);
    }
    for (const option of answered)
      if (oldOptions.includes(option) && !nextOptions.includes(option))
        add(
          question,
          index,
          "options",
          "historical_option_removed",
          `的选项“${option}”已有历史答案，不能删除、改名或修剪空白；请恢复原文，或新建另一份问卷。`,
        );
  }
  return issues;
}
