import React, { useState, useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Check,
} from "@phosphor-icons/react";
import { api } from "./api";
import { newSubmissionKey } from "./browser-state.js";
import { unchangedAnswers, downloadAnswerCopy } from "./survey-recovery.js";
import {
  surveyFlow,
  answerError,
  exclusiveOptionsFor,
  surveyAnswerProgress,
} from "../server/validation.js";
import "./survey-advanced.css";

export function surveySections(questions) {
  const groups = [];
  for (const question of questions) {
    const title = question.section || "问题";
    if (groups.at(-1)?.title !== title) groups.push({ title, questions: [] });
    groups.at(-1).questions.push(question);
  }
  return groups;
}

export function pruneSurveyAnswers(survey, input) {
  const answers =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const clean = {};
  for (const q of surveyFlow(survey, answers).questions) {
    if (Object.hasOwn(answers, q.id)) clean[q.id] = answers[q.id];
    const selected = Array.isArray(answers[q.id])
      ? answers[q.id]
      : [answers[q.id]];
    if (
      q.allowOther &&
      selected.includes("其他") &&
      Object.hasOwn(answers, q.id + "__other")
    ) {
      clean[q.id + "__other"] = answers[q.id + "__other"];
    }
  }
  return clean;
}

export function toggleSurveyOption(q, value, option) {
  const values = Array.isArray(value) ? value : [];
  if (values.includes(option)) return values.filter((item) => item !== option);
  const exclusive = exclusiveOptionsFor(q);
  return exclusive.includes(option)
    ? [option]
    : [...values.filter((item) => !exclusive.includes(item)), option];
}
export function Ranking({ options, value, onChange }) {
  const move = (i, d) => {
    const a = [...value];
    [a[i], a[i + d]] = [a[i + d], a[i]];
    onChange(a);
  };
  return (
    <div className="ranking">
      {value.map((x, i) => (
        <div
          key={x}
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i))}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const from = Number(e.dataTransfer.getData("text/plain"));
            if (!Number.isInteger(from) || from < 0 || from >= value.length)
              return;
            const a = [...value];
            const [item] = a.splice(from, 1);
            a.splice(i, 0, item);
            onChange(a);
          }}
        >
          <span className="rank-number">{i + 1}</span>
          <span>{x}</span>
          <button
            type="button"
            disabled={!i}
            aria-label={"上移 " + x}
            onClick={() => move(i, -1)}
          >
            <ArrowUp />
          </button>
          <button
            type="button"
            disabled={i === value.length - 1}
            aria-label={"下移 " + x}
            onClick={() => move(i, 1)}
          >
            <ArrowDown />
          </button>
        </div>
      ))}
    </div>
  );
}
export const visible = (q, a) =>
  !q.condition?.questionId ||
  (Array.isArray(a[q.condition.questionId])
    ? a[q.condition.questionId]
    : [a[q.condition.questionId]]
  ).includes(q.condition.value);
export function QuestionInput({
  q,
  value,
  onChange,
  otherValue,
  onOtherChange,
  error,
}) {
  const values = Array.isArray(value) ? value : [];
  const exclusive = exclusiveOptionsFor(q);
  const toggle = (o) => onChange(toggleSurveyOption(q, values, o));
  return (
    <fieldset
      className="survey-question"
      id={`question-${q.id}`}
      tabIndex={-1}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `question-error-${q.id}` : undefined}
    >
      <legend>
        {q.title}
        {q.required && <span className="required"> *</span>}
      </legend>
      {q.description && <p>{q.description}</p>}
      {Boolean(q.min || q.max) && (
        <p className="fine">
          {q.min ? `至少${q.min}项 ` : ""}
          {q.max ? `最多${q.max}项` : ""}
        </p>
      )}
      {exclusive.length > 0 && (
        <p className="fine survey-exclusive-hint">
          标注“单独选择”的选项不能与其他选项同时选择
          {q.min ? "，单独选择时不受最少项数限制" : ""}。
        </p>
      )}
      {q.type === "text" ? (
        <textarea
          aria-label={q.title}
          rows={4}
          maxLength={10000}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="写下你的回答…"
        />
      ) : q.type === "matrix" ? (
        <MatrixInput q={q} value={value} onChange={onChange} />
      ) : q.type === "rank" ? (
        <>
          <p className="fine">
            拖动排序，或使用上下箭头。请先点击确认初始顺序，或调整顺序。
          </p>
          {!Array.isArray(value) && (
            <button
              type="button"
              className="quiet"
              onClick={() => onChange([...q.options])}
            >
              确认当前顺序
            </button>
          )}
          <Ranking
            options={q.options}
            value={Array.isArray(value) ? value : q.options}
            onChange={onChange}
          />
        </>
      ) : (
        <>
          <div className="answer-options">
            {[
              ...new Set([...q.options, ...(q.allowOther ? ["其他"] : [])]),
            ].map((o) => (
              <label className="answer-option" key={o}>
                <input
                  type={q.type === "single" ? "radio" : "checkbox"}
                  name={q.id}
                  checked={
                    q.type === "single" ? value === o : values.includes(o)
                  }
                  onChange={() =>
                    q.type === "single" ? onChange(o) : toggle(o)
                  }
                />
                <span className="answer-label">
                  {o}
                  {exclusive.includes(o) && (
                    <small className="answer-exclusive">单独选择</small>
                  )}
                </span>
              </label>
            ))}
          </div>
          {q.allowOther &&
            (q.type === "single"
              ? value === "其他"
              : values.includes("其他")) && (
              <label className="other-answer">
                请补充其他内容
                <input
                  value={typeof otherValue === "string" ? otherValue : ""}
                  maxLength={10000}
                  onChange={(e) => onOtherChange(e.target.value)}
                />
              </label>
            )}
          {q.type === "multirank" && values.length > 0 && (
            <>
              <p className="fine">为你选中的项目排序</p>
              <Ranking value={values} onChange={onChange} />
            </>
          )}
        </>
      )}
      {error && (
        <p className="error question-error" id={`question-error-${q.id}`}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

function MatrixInput({ q, value, onChange }) {
  const selected =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const choose = (row, option) => {
    const next = { ...selected };
    if (option === null) delete next[row];
    else next[row] = option;
    onChange(next);
  };
  return (
    <div className="survey-matrix">
      <p className="fine">
        每行选择一项
        {q.required ? "，所有行都需要回答。" : "，可以跳过不适用的项目。"}
      </p>
      <table className="matrix-table" aria-label={q.title}>
        <thead>
          <tr>
            <th scope="col">评价项目</th>
            {q.options.map((option) => (
              <th scope="col" key={option}>
                {option}
              </th>
            ))}
            {!q.required && (
              <th scope="col">
                <span className="survey-sr-only">清除回答</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {(q.rows || []).map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.title}</th>
              {q.options.map((option) => (
                <td key={option}>
                  <label className="matrix-choice">
                    <input
                      type="radio"
                      name={`${q.id}-row-${row.id}`}
                      aria-label={`${row.title}：${option}`}
                      checked={selected[row.id] === option}
                      onChange={() => choose(row.id, option)}
                    />
                    <span className="matrix-mobile-label" aria-hidden="true">
                      {option}
                    </span>
                  </label>
                </td>
              ))}
              {!q.required && (
                <td className="matrix-clear-cell">
                  <button
                    type="button"
                    className="quiet matrix-clear"
                    disabled={!selected[row.id]}
                    aria-label={`清除“${row.title}”的回答`}
                    onClick={() => choose(row.id, null)}
                  >
                    清除
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export default function Survey({ id, preview, standalone = false, onSubmissionSuccess, onRestart }) {
  const [survey, setSurvey] = useState(preview || null);
  const [answers, setAnswers] = useState({});
  const answersRef = useRef({});
  const [section, setSection] = useState(0);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [success, setSuccess] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [resultsError, setResultsError] = useState("");
  const [draft, setDraft] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [previousCopy, setPreviousCopy] = useState(null);
  const submissionKey = useRef(null);
  const attempt = useRef(null);
  const inflight = useRef(false);
  const lifecycle = useRef(null);

  const setCurrentAnswers = (next) => {
    answersRef.current = next;
    setAnswers(next);
  };
  const storeDraft = (currentSurvey, next) => {
    if (preview) return;
    try {
      localStorage.setItem(
        "survey-" + id,
        JSON.stringify({
          revision: currentSurvey.updatedAt,
          definitionVersion: currentSurvey.definitionVersion,
          submissionKey: submissionKey.current,
          pending: Boolean(attempt.current),
          surveySnapshot: currentSurvey,
          answers: next,
        }),
      );
      setDraft(true);
      setStorageUnavailable(false);
    } catch {
      setDraft(false);
      setStorageUnavailable(true);
    }
  };
  const removeDraft = () => {
    if (preview) return;
    try {
      localStorage.removeItem("survey-" + id);
    } catch {
      setStorageUnavailable(true);
    }
  };

  useEffect(() => {
    let active = true;
    const currentVisit = {};
    lifecycle.current = currentVisit;
    const dispose = () => {
      active = false;
      if (lifecycle.current === currentVisit) lifecycle.current = null;
    };
    setCurrentAnswers({});
    setSection(0);
    setError("");
    setFieldErrors({});
    setSuccess(null);
    setResults(null);
    setResultsError("");
    setDraft(false);
    setStorageUnavailable(false);
    setVersionConflict(false);
    setUncertain(false);
    setBusy(false);
    inflight.current = false;
    setPreviousCopy(null);
    submissionKey.current = newSubmissionKey();
    attempt.current = null;
    if (preview) {
      setSurvey(preview);
      return dispose;
    }
    setSurvey(null);
    let stored = null;
    try {
      const candidate = JSON.parse(localStorage.getItem("survey-" + id) || "null");
      if (candidate?.answers && typeof candidate.answers === "object" && !Array.isArray(candidate.answers)) stored = candidate;
    } catch { setStorageUnavailable(true); }
    const storedSnapshot = stored?.surveySnapshot?.id === id && Array.isArray(stored.surveySnapshot.questions)
      ? stored.surveySnapshot : null;
    // Receipt confirmation must work even when the public questionnaire has
    // closed since the original request. Do not gate it on a fresh public GET.
    if (stored?.pending && typeof stored.submissionKey === "string" && storedSnapshot) {
      submissionKey.current = stored.submissionKey;
      attempt.current = { answers: stored.answers, definitionVersion: stored.definitionVersion, submissionKey: stored.submissionKey };
      setSurvey(storedSnapshot);
      setCurrentAnswers(stored.answers);
      setUncertain(true);
      setDraft(true);
      return dispose;
    }
    api("/surveys/" + encodeURIComponent(id))
      .then((s) => {
        if (!active) return;
        setSurvey(s);
        if (stored) {
          if (
            stored &&
            (stored.definitionVersion === s.definitionVersion || (!stored.definitionVersion && stored.revision === s.updatedAt)) &&
            stored.answers &&
            typeof stored.answers === "object" &&
            !Array.isArray(stored.answers)
          ) {
            submissionKey.current = stored.submissionKey || submissionKey.current;
            const clean = pruneSurveyAnswers(s, stored.answers);
            setCurrentAnswers(clean);
            storeDraft(s, clean);
          } else {
            // Legacy drafts have no definition snapshot. Keep their answers
            // downloadable, but never attach them to newly worded questions.
            setSurvey(storedSnapshot || { id, title: s.title, questions: [], definitionVersion: stored.definitionVersion });
            setCurrentAnswers(stored.answers);
            setVersionConflict(true);
            setDraft(true);
          }
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          if (stored) {
            setSurvey(storedSnapshot || { id, title: "已保存的问卷草稿", questions: [], definitionVersion: stored.definitionVersion });
            setCurrentAnswers(stored.answers);
            setVersionConflict(true);
            setDraft(true);
          }
        }
      });
    return dispose;
  }, [id, preview]);

  const change = (key, value) => {
    if (busy || uncertain || versionConflict) return;
    const before = surveyFlow(survey, answersRef.current);
    const clean = pruneSurveyAnswers(survey, {
      ...answersRef.current,
      [key]: value,
    });
    const after = surveyFlow(survey, clean);
    setCurrentAnswers(clean);
    setError("");
    setFieldErrors({});
    if (
      before.questions.map((q) => q.id).join("|") !==
      after.questions.map((q) => q.id).join("|")
    ) {
      const questionId = key.endsWith("__other") ? key.slice(0, -7) : key;
      const nextGroups = surveySections(after.questions);
      const editedGroup = nextGroups.findIndex((group) =>
        group.questions.some((q) => q.id === questionId),
      );
      setSection(editedGroup >= 0 ? editedGroup : 0);
    }
    storeDraft(survey, clean);
  };

  if (!survey)
    return (
      <div className="page survey-state">
        {!standalone && <a className="back" href="/?page=you">
          <ArrowLeft /> 返回问卷
        </a>}
        <section role={error ? "alert" : "status"}>
          {error && <h1>问卷暂时无法填写</h1>}
          <p>{error || "正在打开问卷…"}</p>
        </section>
      </div>
    );

  const { questions, termination } = surveyFlow(survey, answers);
  const progress = surveyAnswerProgress(survey, answers);
  const sections = surveySections(questions);
  const current = Math.min(section, Math.max(0, sections.length - 1));
  const active = sections[current]?.questions || [];
  const lastSection = current >= sections.length - 1;
  const check = (items) => {
    const errors = {};
    for (const q of items) {
      const message = answerError(q, answersRef.current);
      if (message) errors[q.id] = message;
    }
    setFieldErrors(errors);
    const first = items.find((q) => errors[q.id]);
    if (!first) return true;
    setError(errors[first.id]);
    const errorSection = sections.findIndex((group) =>
      group.questions.some((q) => q.id === first.id),
    );
    if (errorSection >= 0) setSection(errorSection);
    requestAnimationFrame(() =>
      document.getElementById(`question-${first.id}`)?.focus(),
    );
    return false;
  };
  const clearAnswers = () => {
    submissionKey.current = newSubmissionKey();
    attempt.current = null;
    setUncertain(false);
    setVersionConflict(false);
    setPreviousCopy(null);
    removeDraft();
    setCurrentAnswers({});
    setSection(0);
    setDraft(false);
    setError("");
    setFieldErrors({});
    setSuccess(null);
    setResults(null);
    setResultsError("");
    onRestart?.();
  };
  const reloadSurvey = async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    const currentVisit = lifecycle.current;
    try {
      const current = await api("/surveys/" + encodeURIComponent(id));
      if (lifecycle.current !== currentVisit) return;
      const previous = { survey, answers: structuredClone(answersRef.current) };
      const clean = pruneSurveyAnswers(current, unchangedAnswers(survey, current, answersRef.current));
      setPreviousCopy(previous);
      submissionKey.current = newSubmissionKey();
      attempt.current = null;
      setSurvey(current);
      setCurrentAnswers(clean);
      setSection(0);
      setFieldErrors({});
      setError("");
      setVersionConflict(false);
      setUncertain(false);
      storeDraft(current, clean);
    } catch (e) { if (lifecycle.current === currentVisit) setError(e.message); }
    finally { if (lifecycle.current === currentVisit) { inflight.current = false; setBusy(false); } }
  };
  const loadResults = async () => {
    setResultsError("");
    const currentVisit = lifecycle.current;
    try {
      const result = await api("/surveys/" + encodeURIComponent(id) + "/results");
      if (lifecycle.current === currentVisit) setResults(result);
    } catch {
      if (lifecycle.current === currentVisit) setResultsError("回答已保存，统计暂时无法加载。");
    }
  };
  async function submit(e) {
    e.preventDefault();
    if (inflight.current || versionConflict) return;
    setError("");
    if (!attempt.current && !lastSection) {
      if (check(active)) setSection(current + 1);
      return;
    }
    if (!attempt.current && !check(questions)) return;
    if (preview) {
      setSuccess({
        message: termination
          ? "预览完成：问卷提前结束，未保存答卷。"
          : "预览完成，未保存答卷。",
        completion: termination ? "terminated" : "completed",
        termination,
      });
      return;
    }
    setBusy(true);
    inflight.current = true;
    const currentVisit = lifecycle.current;
    try {
      const clean = pruneSurveyAnswers(survey, answersRef.current);
      attempt.current ||= { answers: clean, definitionVersion: survey.definitionVersion, submissionKey: submissionKey.current || newSubmissionKey() };
      storeDraft(survey, attempt.current.answers);
      const result = await api("/surveys/" + encodeURIComponent(id) + "/submit", {
        method: "POST",
        body: attempt.current,
      });
      if (lifecycle.current !== currentVisit) return;
      if (!result || !["completed", "terminated"].includes(result.completion)) {
        throw Object.assign(new Error("服务器未返回有效的提交确认，请重试确认本次提交。"), { code: "INVALID_RESPONSE" });
      }
      setUncertain(false);
      setSuccess({
        message: result.message || "回答已保存。",
        completion: result.completion,
        termination: result.termination,
      });
      removeDraft();
      setDraft(false);
      onSubmissionSuccess?.(id, result);
      if (survey.publicResults) await loadResults();
    } catch (e) {
      if (lifecycle.current !== currentVisit) return;
      setError(e.message);
      const unknown = e.code === "INVALID_RESPONSE" || !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
      setUncertain(unknown);
      if (!unknown) {
        attempt.current = null;
        storeDraft(survey, answersRef.current);
      }
      if (e.code === "SURVEY_VERSION_CONFLICT") setVersionConflict(true);
    } finally {
      if (lifecycle.current === currentVisit) {
        inflight.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <div className={preview ? "survey-preview" : "reading survey-page"}>
      {!preview && !standalone && (
        <a className="back" href="/?page=you">
          <ArrowLeft /> 返回问卷
        </a>
      )}
      <span className="eyebrow">
        {preview ? "PREVIEW / 预览" : standalone ? "QUESTIONNAIRE / 问卷" : "ABOUT YOU / 关于你"}
      </span>
      <h1>{survey.title}</h1>
      <p className="survey-description">{survey.description}</p>
      {success ? (
        <div className="success" role="status">
          <Check size={36} />
          <h2>{success.message}</h2>
          {success.completion === "terminated" && (
            <p className="fine">
              本次问卷已提前结束{preview ? "。" : "，已填写的回答已保存。"}
            </p>
          )}
          {results && <SurveyResults results={results} />}
          {resultsError && (
            <p className="fine">
              {resultsError}{" "}
              <button className="quiet" onClick={loadResults}>
                重新加载统计
              </button>
            </p>
          )}
          <button className="quiet" disabled={busy} onClick={clearAnswers}>
            重新填写
          </button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          {versionConflict && (
            <section className="module-recovery" role="alert">
              <p>问卷已经更新，当前答案仍保留。加载新版后，只有题目定义未变化的答案会保留，其他题目请重新确认。</p>
              <button type="button" className="quiet" onClick={() => downloadAnswerCopy(survey, answersRef.current)}>下载当前填写副本</button>{" "}
              <button type="button" className="quiet" disabled={busy} onClick={reloadSurvey}>加载最新问卷</button>
            </section>
          )}
          {previousCopy && <p className="draft-note">已加载最新问卷，请确认变更的题目。 <button type="button" onClick={() => downloadAnswerCopy(previousCopy.survey, previousCopy.answers)}>下载更新前的填写副本</button></p>}
          {uncertain && <p className="draft-note" role="status">上一次提交结果尚未确认。重试会确认同一次提交，不会重复保存。</p>}
          {draft && (
            <p className="draft-note">
              已保存本机草稿 · 刷新后可继续{" "}
              <button type="button" disabled={busy || uncertain || versionConflict} onClick={clearAnswers}>
                清除
              </button>
            </p>
          )}
          {storageUnavailable && (
            <p className="draft-note" role="status">
              当前浏览器无法保存本机草稿，回答仍可正常提交；请先不要关闭本页。
            </p>
          )}
          {progress.total > 0 && <div
            className="survey-progress"
            role="progressbar"
            aria-label="必答项填写进度"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.answered}
            aria-valuetext={`已填写 ${progress.answered} / ${progress.total} 项必答项，${progress.percent}%，尚未提交`}
          >
            <div
              style={{
                width:
                  progress.percent + "%",
              }}
            />
          </div>}
          <p className="fine survey-progress-caption" role="status">
            {termination ? "已触发结束条件，待提交" : progress.total
              ? `已填写 ${progress.answered} / ${progress.total} 项必答项 · ${progress.percent}%${progress.answered === progress.total ? " · 待提交" : ""}`
              : "全部为选填，可直接提交"}
          </p>
          <div className="section-head">
            <h2>{sections[current]?.title || "问题"}</h2>
            <span className="mono">
              第 {current + 1} / {Math.max(1, sections.length)} 部分
            </span>
          </div>
          <fieldset className="survey-active-section" disabled={busy || uncertain || versionConflict}>
            <legend className="survey-sr-only">
              {sections[current]?.title || "当前部分"}
            </legend>
            {active.map((q) => (
              <QuestionInput
                key={q.id}
                q={q}
                value={answers[q.id]}
                onChange={(value) => change(q.id, value)}
                otherValue={answers[q.id + "__other"]}
                onOtherChange={(value) => change(q.id + "__other", value)}
                error={fieldErrors[q.id]}
              />
            ))}
          </fieldset>
          {termination && lastSection && (
            <div className="survey-end-notice" role="status">
              <strong>本次问卷将在这里结束</strong>
              <p>
                你在“{termination.questionTitle}”中选择了“{termination.option}
                ”。后续问题无需填写。
                {survey.terminationMessage || "感谢你参与这次问卷。"}
              </p>
              <p>
                点击“结束并提交”后才会保存回答；提交前仍可修改选项或返回上一部分。
              </p>
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="survey-actions">
            {current > 0 && (
              <button
                type="button"
                className="quiet"
                disabled={busy || uncertain || versionConflict}
                onClick={() => {
                  setSection(current - 1);
                  setError("");
                }}
              >
                <ArrowLeft /> 上一部分
              </button>
            )}
            <button className="button" disabled={busy || versionConflict}>
              {busy
                ? "正在保存…"
                : uncertain
                  ? "重试确认提交结果"
                : !lastSection
                  ? "下一部分"
                  : termination
                    ? "结束并提交"
                    : "提交回答"}
              <ArrowRight />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SurveyResults({ results }) {
  return (
    <section className="survey-public-results" aria-label="公开统计">
      <p>
        共有 {results.count} 份回答
        {results.completionCounts && (
          <span className="completion-counts">
            完整完成 {results.completionCounts.completed} 份 · 提前结束{" "}
            {results.completionCounts.terminated} 份
          </span>
        )}
      </p>
      {(results.summary || [])
        .filter((q) => q.counts || q.matrix)
        .map((q) => (
          <div className="result-block" key={q.id}>
            <h3>{q.title}</h3>
            {q.matrix
              ? q.matrix.map((row) => (
                  <div className="matrix-result-row" key={row.id}>
                    <h4>
                      {row.title}
                      <small>{row.answered} 人回答</small>
                    </h4>
                    <div className="matrix-result-counts">
                      {Object.entries(row.counts || {}).map(
                        ([option, count]) => (
                          <p key={option}>
                            <span>{option}</span>
                            <strong>{count}</strong>
                          </p>
                        ),
                      )}
                    </div>
                  </div>
                ))
              : Object.entries(q.counts).map(([option, count]) => (
                  <p key={option}>
                    {option}：{count}
                  </p>
                ))}
          </div>
        ))}
    </section>
  );
}
