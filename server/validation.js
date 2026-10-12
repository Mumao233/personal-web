export function visibleQuestions(survey, answers) {
  const shown = new Set();
  return (survey.questions || []).filter((q) => {
    const c = q.condition;
    const visible =
      !c?.questionId ||
      (shown.has(c.questionId) &&
        (Array.isArray(answers[c.questionId])
          ? answers[c.questionId]
          : [answers[c.questionId]]
        ).includes(c.value));
    if (visible) shown.add(q.id);
    return visible;
  });
}
export function validateSurvey(s) {
  if (!s.title?.trim() || s.title.length > 200)
    throw Error("请填写问卷标题（最多200字）");
  if (
    !Array.isArray(s.questions) ||
    !s.questions.length ||
    s.questions.length > 100
  )
    throw Error("问卷需要1至100个题目");
  const ids = new Set();
  for (const q of s.questions) {
    if (!q.id || ids.has(q.id) || !q.title?.trim())
      throw Error("题目编号需唯一，且标题不可为空");
    ids.add(q.id);
    if (!["single", "multiple", "rank", "multirank", "text"].includes(q.type))
      throw Error("不支持的题型");
    if (
      q.type !== "text" &&
      (!Array.isArray(q.options) ||
        q.options.length < 2 ||
        new Set(q.options).size !== q.options.length ||
        q.options.some((x) => typeof x !== "string" || !x.trim()))
    )
      throw Error("选择与排序题需要至少两个不同选项");
    if (q.condition?.questionId && !ids.has(q.condition.questionId))
      throw Error("条件必须引用之前的题目");
    if (q.condition?.questionId === q.id) throw Error("题目不能引用自己");
    if (q.condition?.questionId) {
      const p = s.questions.find((p) => p.id === q.condition.questionId);
      if (
        ![...(p?.options || []), ...(p?.allowOther ? ["其他"] : [])].includes(
          q.condition.value,
        )
      )
        throw Error("条件答案必须是前置题目的有效选项");
    }
    if (
      q.min < 0 ||
      q.max < 0 ||
      (q.max && q.min > q.max) ||
      (q.max && q.max > (q.options?.length || 0) + (q.allowOther ? 1 : 0))
    )
      throw Error("选择数量范围无效");
  }
  if (
    (s.startsAt && isNaN(Date.parse(s.startsAt))) ||
    (s.endsAt && isNaN(Date.parse(s.endsAt)))
  )
    throw Error("时间格式无效");
  if (s.startsAt && s.endsAt && new Date(s.startsAt) >= new Date(s.endsAt))
    throw Error("截止时间须晚于开始时间");
  return s;
}
export function validateAnswers(s, answers) {
  const clean = {};
  for (const q of visibleQuestions(s, answers)) {
    const a = answers[q.id];
    const empty = a == null || a === "" || (Array.isArray(a) && !a.length);
    if (empty) {
      if (q.required) throw Error(`请回答：${q.title}`);
      continue;
    }
    if (q.type === "text") {
      if (typeof a !== "string" || a.length > 10000)
        throw Error("文字回答最多10000字");
      clean[q.id] = a;
      continue;
    }
    const values = q.type === "single" ? [a] : a;
    if (
      !Array.isArray(values) ||
      values.some(
        (x) => ![...q.options, ...(q.allowOther ? ["其他"] : [])].includes(x),
      ) ||
      new Set(values).size !== values.length
    )
      throw Error(`选项无效：${q.title}`);
    if (q.allowOther && values.includes("其他")) {
      const other = answers[q.id + "__other"];
      if (typeof other !== "string" || !other.trim() || other.length > 10000)
        throw Error(`请补充“其他”的内容：${q.title}`);
      clean[q.id + "__other"] = other.trim();
    }
    if (q.type === "rank" && values.length !== q.options.length)
      throw Error(`请对全部选项排序：${q.title}`);
    if ((q.min && values.length < q.min) || (q.max && values.length > q.max))
      throw Error(`选择数量不符合要求：${q.title}`);
    clean[q.id] = q.type === "single" ? a : values;
  }
  return clean;
}
