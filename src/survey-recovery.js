// Only reuse answers when the full question definition is unchanged. A stable
// ID alone is insufficient: labels, options and conditions affect its meaning.
export function unchangedAnswers(previous, current, answers) {
  const old = new Map((previous.questions || []).map(question => [question.id, question]));
  const result = {};
  for (const question of current.questions || []) {
    if (JSON.stringify(old.get(question.id)) !== JSON.stringify(question)) continue;
    for (const key of [question.id, question.id + "__other"])
      if (Object.hasOwn(answers, key)) result[key] = answers[key];
  }
  return result;
}

export function downloadAnswerCopy(survey, answers) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({
    title: survey.title, definitionVersion: survey.definitionVersion,
    questions: survey.questions, answers,
  }, null, 2)], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "questionnaire-answers.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
