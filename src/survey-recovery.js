// Only reuse answers when the full question definition is unchanged. A stable
// ID alone is insufficient: labels, options and conditions affect its meaning.
export function unchangedAnswers(previous, current, answers) {
  const old = new Map(
    (previous.questions || []).map((question) => [question.id, question]),
  );
  const result = {};
  for (const question of current.questions || []) {
    if (JSON.stringify(old.get(question.id)) !== JSON.stringify(question))
      continue;
    for (const key of [question.id, question.id + "__other"])
      if (Object.hasOwn(answers, key)) result[key] = answers[key];
  }
  return result;
}

function downloadJson(value, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadAnswerCopy(survey, answers, pendingRequest) {
  downloadJson(
    {
      title: survey.title,
      definitionVersion: survey.definitionVersion,
      questions: survey.questions,
      answers,
      ...(pendingRequest ? { pendingRequest } : {}),
    },
    "questionnaire-answers.json",
  );
}

// Old malformed records must remain exportable verbatim, including fields this
// version cannot interpret. Do not manufacture an empty answer copy for them.
export function downloadLegacyRecovery(record) {
  const original = record.original;
  downloadJson(
    {
      originalText: record.legacyRaw,
      originalRecord: original,
      recoveryRecord: record,
      ...(original?.answers
        ? {
            answers: original.answers,
            questions: original.surveySnapshot?.questions || [],
          }
        : {}),
    },
    "questionnaire-original-recovery.json",
  );
}

export async function boundedSurveyLoad(
  request,
  { timeoutMs = 15000, signal } = {},
) {
  const controller = new AbortController();
  let timer, rejectCancelled;
  const cancelled = new Promise((_, reject) => {
    rejectCancelled = reject;
  });
  const cancel = () => {
    controller.abort();
    rejectCancelled(
      Object.assign(new Error("已取消本次问卷加载。"), {
        code: "LOAD_CANCELLED",
      }),
    );
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(
          new Error("问卷加载超时，当前答案仍保留，请重新加载问卷。"),
          { code: "SURVEY_LOAD_TIMEOUT" },
        ),
      );
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => request(controller.signal)),
      cancelled,
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
