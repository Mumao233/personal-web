import { createHash } from "node:crypto";

export function stableJSON(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJSON).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => JSON.stringify(key) + ":" + stableJSON(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const fingerprint = (value) =>
  createHash("sha256").update(stableJSON(value)).digest("hex");
export const revisionOf = (record) =>
  Number.isSafeInteger(record?.revision) ? record.revision : 0;
export function assertRevision(record, revision, code = "REVISION_CONFLICT") {
  if (!Number.isSafeInteger(revision) || revision !== revisionOf(record))
    throw Object.assign(
      Error(
        "内容已在其他窗口更新，请重新载入后再保存；你的修改尚未覆盖服务器内容。",
      ),
      { status: 409, code },
    );
}
export const surveyDefinitionVersion = (survey) =>
  fingerprint({
    title: survey.title,
    description: survey.description || "",
    questions: survey.questions || [],
    terminationMessage: survey.terminationMessage || "",
    successMessage: survey.successMessage || "",
  });
export const versionedSurvey = (survey) => ({
  ...survey,
  revision: revisionOf(survey),
  definitionVersion: surveyDefinitionVersion(survey),
});

// A stable ID alone does not identify meaning: keep distinct question definitions
// in separate export columns, including row labels/options and validation rules.
export function surveyExport(survey, rows) {
  const columns = new Map();
  const snapshots = new Map(
    rows.map((row) => {
      const questions = [...(row.questions || [])];
      for (const [id, answer] of Object.entries(row.answers || {})) {
        if (
          id.endsWith("__other") ||
          questions.some((question) => question.id === id)
        )
          continue;
        // Older imports may have answers without definitions. Retain these under
        // explicitly unknown labels, never relabel them with today's questions.
        const matrix =
          answer && typeof answer === "object" && !Array.isArray(answer);
        questions.push({
          id,
          title: `${id}（历史定义缺失）`,
          type: matrix ? "matrix" : "unknown",
          ...(matrix
            ? {
                rows: Object.keys(answer).map((rowId) => ({
                  id: rowId,
                  title: rowId,
                })),
              }
            : {}),
        });
      }
      return [row, questions];
    }),
  );
  for (const question of [
    ...survey.questions,
    ...rows.flatMap((row) => snapshots.get(row)),
  ]) {
    const definition = fingerprint(question);
    const entries =
      question.type === "matrix"
        ? (question.rows || []).map((row) => ({
            rowId: row.id,
            title: `${question.title} · ${row.title}`,
          }))
        : [{ rowId: null, title: question.title }];
    for (const entry of entries) {
      const key = JSON.stringify([question.id, definition, entry.rowId]);
      columns.set(key, {
        ...entry,
        questionId: question.id,
        definition,
        type: question.type,
      });
    }
  }
  const versions = new Map();
  for (const column of columns.values()) {
    if (!versions.has(column.questionId))
      versions.set(column.questionId, new Set());
    versions.get(column.questionId).add(column.definition);
  }
  const entries = [...columns.values()];
  const headers = [
    "提交编号",
    "时间",
    "完成状态",
    "结束题目",
    "结束选项",
    "问卷定义版本",
    ...entries.map(
      (column) =>
        column.title +
        (versions.get(column.questionId).size > 1
          ? ` [${column.type} / ${column.definition.slice(0, 10)}]`
          : ""),
    ),
  ];
  const values = rows.map((row) => [
    row.id,
    row.createdAt,
    row.completion === "terminated" ? "提前结束" : "完整完成",
    row.termination?.questionTitle || "",
    row.termination?.option || "",
    row.definitionVersion || "历史快照",
    ...entries.map((column) => {
      const original = snapshots
        .get(row)
        .find((question) => question.id === column.questionId);
      if (!original || fingerprint(original) !== column.definition) return "";
      const answer = Object.hasOwn(row.answers || {}, column.questionId)
        ? row.answers[column.questionId]
        : undefined;
      if (column.rowId !== null)
        return answer &&
          typeof answer === "object" &&
          !Array.isArray(answer) &&
          Object.hasOwn(answer, column.rowId)
          ? answer[column.rowId]
          : "";
      const other = Object.hasOwn(
        row.answers || {},
        column.questionId + "__other",
      )
        ? row.answers[column.questionId + "__other"]
        : "";
      return (
        (Array.isArray(answer)
          ? answer.join(" → ")
          : typeof answer === "string"
            ? answer
            : "") + (other ? ` [其他：${other}]` : "")
      );
    }),
  ]);
  return { headers, values };
}
