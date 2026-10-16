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
import {
  unchangedAnswers,
  downloadAnswerCopy,
  downloadLegacyRecovery,
  boundedSurveyLoad,
} from "./survey-recovery.js";
import { createSurveyStorage } from "./survey-storage.js";
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
function RecoveryConfirmation({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  onDownload,
  busy,
}) {
  const panel = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.querySelector("button")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div
      className="survey-confirm-layer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
        if (event.key !== "Tab") return;
        const nodes = [
          ...panel.current.querySelectorAll("button:not(:disabled)"),
        ];
        if (!nodes.length) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === nodes[0]) {
          event.preventDefault();
          nodes.at(-1).focus();
        } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
          event.preventDefault();
          nodes[0].focus();
        }
      }}
    >
      <section
        ref={panel}
        className="survey-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="survey-confirm-title"
        aria-describedby="survey-confirm-message"
      >
        <h2 id="survey-confirm-title">{title}</h2>
        <p id="survey-confirm-message">{message}</p>
        <div className="survey-recovery-actions">
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          {onDownload && (
            <button type="button" className="quiet" onClick={onDownload}>
              下载当前答案
            </button>
          )}
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function Survey({
  id,
  preview,
  standalone = false,
  onSubmissionSuccess,
  onRestart,
}) {
  const [survey, setSurvey] = useState(preview || null);
  const [answers, setAnswers] = useState({});
  const answersRef = useRef({});
  const surveyRef = useRef(preview || null);
  const [section, setSection] = useState(0);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [success, setSuccess] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [resultsError, setResultsError] = useState("");
  const [storageState, setStorageState] = useState(null);
  const [recoveries, setRecoveries] = useState([]);
  const [showRecoveries, setShowRecoveries] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const [keyConflict, setKeyConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [previousCopy, setPreviousCopy] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const submissionKey = useRef(null);
  const attempt = useRef(null);
  const pendingId = useRef(null);
  const storage = useRef(null);
  const inflight = useRef(false);
  const lifecycle = useRef(null);
  const definitionRequest = useRef(null);
  const definitionGeneration = useRef(0);
  const sectionHeading = useRef(null);
  const sectionFocus = useRef(false);

  useEffect(() => {
    if (!sectionFocus.current) return;
    sectionFocus.current = false;
    sectionHeading.current?.focus({ preventScroll: true });
    sectionHeading.current?.scrollIntoView?.({
      behavior: "auto",
      block: "start",
    });
  }, [section]);
  const goToSection = (next) => {
    sectionFocus.current = true;
    setSection(next);
  };

  const setCurrentAnswers = (next) => {
    answersRef.current = next;
    setAnswers(next);
  };
  const setCurrentSurvey = (next) => {
    surveyRef.current = next;
    setSurvey(next);
  };
  const syncStorage = async (
    controller = storage.current,
    visit = lifecycle.current,
  ) => {
    if (!controller) return null;
    const state = await controller.getState();
    if (lifecycle.current === visit && storage.current === controller)
      setStorageState(state);
    return state;
  };
  const refreshRecoveries = async (
    controller = storage.current,
    visit = lifecycle.current,
  ) => {
    if (!controller) return;
    const records = await controller.listRecoverable();
    if (lifecycle.current === visit && storage.current === controller)
      setRecoveries(records);
  };
  const storeDraft = async (currentSurvey, next, conflict = false) => {
    if (preview || !storage.current) return;
    const controller = storage.current,
      visit = lifecycle.current;
    await controller.saveDraft({
      surveySnapshot: currentSurvey,
      answers: next,
      definitionVersion: currentSurvey.definitionVersion,
      revision: currentSurvey.updatedAt,
      submissionKey: submissionKey.current,
      submissionConflict: conflict,
    });
    await syncStorage(controller, visit);
  };
  const downloadCurrent = () =>
    downloadAnswerCopy(
      surveyRef.current || { id, title: "问卷填写副本", questions: [] },
      answersRef.current,
      attempt.current,
    );
  const requestDefinition = () => {
    definitionRequest.current?.abort();
    const controller = new AbortController();
    definitionRequest.current = controller;
    return boundedSurveyLoad(
      (signal) => api("/surveys/" + encodeURIComponent(id), { signal }),
      { signal: controller.signal },
    );
  };

  // Loading may be retried without clearing the in-memory answers or recovery.
  const loadSurvey = async (state, visit = lifecycle.current) => {
    if (lifecycle.current !== visit) return;
    const generation = ++definitionGeneration.current;
    definitionRequest.current?.abort();
    setError("");
    setLoadFailed(false);
    if (state?.pending) {
      const pending = state.pending;
      pendingId.current = pending.id;
      attempt.current = pending.body;
      submissionKey.current = pending.body.submissionKey;
      setCurrentSurvey(
        pending.surveySnapshot || { id, title: "待确认的问卷", questions: [] },
      );
      setCurrentAnswers(pending.body.answers || {});
      setUncertain(true);
      setVersionConflict(false);
      setKeyConflict(false);
      return;
    }
    const stored = state?.draft;
    const snapshot =
      stored?.surveySnapshot?.id === id &&
      Array.isArray(stored.surveySnapshot.questions)
        ? stored.surveySnapshot
        : null;
    if (stored)
      submissionKey.current = stored.submissionKey || submissionKey.current;
    setKeyConflict(Boolean(stored?.submissionConflict));
    try {
      const current = await requestDefinition();
      if (
        lifecycle.current !== visit ||
        definitionGeneration.current !== generation
      )
        return;
      if (!stored) {
        setCurrentSurvey(current);
        return;
      }
      if (
        snapshot &&
        (stored.definitionVersion === current.definitionVersion ||
          (!stored.definitionVersion && stored.revision === current.updatedAt))
      ) {
        setCurrentSurvey(current);
        setCurrentAnswers(pruneSurveyAnswers(current, stored.answers));
        setVersionConflict(false);
      } else {
        setCurrentSurvey(
          snapshot || {
            id,
            title: current.title,
            questions: [],
            definitionVersion: stored.definitionVersion,
          },
        );
        setCurrentAnswers(stored.answers || {});
        setVersionConflict(true);
      }
    } catch (e) {
      if (
        lifecycle.current !== visit ||
        definitionGeneration.current !== generation
      )
        return;
      setError(e.message);
      setLoadFailed(true);
      if (stored) {
        setCurrentSurvey(
          snapshot || {
            id,
            title: "已保存的问卷草稿",
            questions: [],
            definitionVersion: stored.definitionVersion,
          },
        );
        setCurrentAnswers(stored.answers || {});
      }
    }
  };

  useEffect(() => {
    const visit = {};
    lifecycle.current = visit;
    setCurrentAnswers({});
    setSection(0);
    setError("");
    setFieldErrors({});
    setSuccess(null);
    setResults(null);
    setResultsError("");
    setStorageState(null);
    setRecoveries([]);
    setShowRecoveries(false);
    setVersionConflict(false);
    setKeyConflict(false);
    setUncertain(false);
    setLoadFailed(false);
    setBusy(false);
    setConfirmation(null);
    setPreviousCopy(null);
    inflight.current = false;
    submissionKey.current = newSubmissionKey();
    attempt.current = null;
    pendingId.current = null;
    let controller;
    storage.current = null;
    if (preview) setCurrentSurvey(preview);
    else {
      setCurrentSurvey(null);
      controller = createSurveyStorage({
        surveyId: id,
        onStatus: (state) => {
          if (lifecycle.current === visit) setStorageState(state);
        },
      });
      storage.current = controller;
      (async () => {
        try {
          const state = await controller.initialize();
          if (lifecycle.current !== visit) return;
          setStorageState(state);
          await refreshRecoveries(controller, visit);
          await loadSurvey(state, visit);
        } catch (e) {
          if (lifecycle.current === visit) {
            setError(e.message);
            setLoadFailed(true);
          }
        }
      })();
    }
    const refresh = () => {
      refreshRecoveries(controller, visit).catch(() => {});
    };
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      if (lifecycle.current === visit) lifecycle.current = null;
      definitionGeneration.current++;
      definitionRequest.current?.abort();
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      controller?.release();
    };
  }, [id, preview]);

  const runRecoveryAction = async (action) => {
    if (inflight.current) return;
    const visit = lifecycle.current;
    inflight.current = true;
    setBusy(true);
    try {
      await action(visit);
    } catch (e) {
      if (lifecycle.current === visit) {
        setConfirmation(null);
        setError(
          e.code === "IN_USE"
            ? "此记录正在其他标签页使用，请先关闭那个标签页，再恢复。"
            : e.message,
        );
      }
    } finally {
      if (lifecycle.current === visit) {
        inflight.current = false;
        setBusy(false);
      }
    }
  };
  const retryLoad = () =>
    runRecoveryAction(async (visit) => {
      const state = await syncStorage();
      await loadSurvey(state, visit);
    });
  const resetAnswers = async () => {
    const visit = lifecycle.current,
      controller = storage.current;
    await controller?.clear();
    if (lifecycle.current !== visit) return;
    submissionKey.current = newSubmissionKey();
    attempt.current = null;
    pendingId.current = null;
    setUncertain(false);
    setKeyConflict(false);
    setVersionConflict(false);
    setPreviousCopy(null);
    setCurrentAnswers({});
    setSection(0);
    setError("");
    setFieldErrors({});
    setSuccess(null);
    setResults(null);
    setResultsError("");
    setConfirmation(null);
    await syncStorage();
    if (lifecycle.current === visit) onRestart?.();
  };
  const askClear = () => {
    if (success || !Object.keys(answersRef.current).length)
      runRecoveryAction(resetAnswers);
    else
      setConfirmation({
        title: "确认清除当前答案",
        message:
          "这会清除本次尚未提交的答案和本机草稿。其他标签页的记录不受影响。你可以先下载当前答案。",
        confirmLabel: "确认清除",
        action: resetAnswers,
        download: true,
      });
  };
  const change = (key, value) => {
    if (
      busy ||
      inflight.current ||
      uncertain ||
      versionConflict ||
      keyConflict ||
      loadFailed
    )
      return;
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
      const next = surveySections(after.questions).findIndex((group) =>
        group.questions.some((q) => q.id === questionId),
      );
      setSection(next >= 0 ? next : 0);
    }
    const visit = lifecycle.current;
    storeDraft(survey, clean).catch((e) => {
      if (lifecycle.current === visit) setError(e.message);
    });
  };
  const restoreRecord = (entry) => {
    const action = async (visit) => {
      const controller = storage.current;
      const state = await controller.restore(entry.id);
      if (lifecycle.current !== visit) return;
      setStorageState(state);
      setCurrentAnswers({});
      setSection(0);
      setFieldErrors({});
      setVersionConflict(false);
      setKeyConflict(false);
      setLoadFailed(false);
      setUncertain(false);
      attempt.current = null;
      pendingId.current = null;
      setPreviousCopy(null);
      setConfirmation(null);
      await refreshRecoveries(controller, visit);
      await loadSurvey(state, visit);
    };
    if (Object.keys(answersRef.current).length)
      setConfirmation({
        title: "恢复另一条填写记录",
        message:
          storageState?.mode === "memory"
            ? "恢复后将替换当前页答案。当前答案只在内存中，请先下载需要保留的内容。"
            : "恢复后将显示所选记录。当前已保存的草稿会保留，可从恢复列表再次选择。",
        confirmLabel: "确认恢复",
        action,
        download: true,
      });
    else runRecoveryAction(action);
  };
  const downloadRecord = (entry) => {
    if (entry.kind === "legacy" || entry.downloadOnly) {
      downloadLegacyRecovery(entry.record);
      return;
    }
    const record = entry.record.original || entry.record;
    const body =
      record.body ||
      (record.pending
        ? {
            answers: record.answers,
            definitionVersion: record.definitionVersion,
            submissionKey: record.submissionKey,
          }
        : null);
    downloadAnswerCopy(
      record.surveySnapshot || {
        title: "以前的问卷草稿",
        questions: [],
        definitionVersion: record.definitionVersion,
      },
      body?.answers || record.answers || {},
      body,
    );
  };
  const askDelete = (entry) =>
    setConfirmation({
      title:
        entry.kind === "pending" ? "删除待确认的恢复记录" : "删除本机填写记录",
      message:
        entry.kind === "pending"
          ? "这只删除本机恢复副本，不会撤销服务器上可能已经保存的答卷。重新填写可能产生另一份答卷和统计记录。请先下载需要保留的答案。"
          : "这会删除所选的本机草稿，无法撤销。其他填写记录不受影响。",
      confirmLabel: "确认删除",
      download: entry.id === pendingId.current,
      action: async (visit) => {
        const controller = storage.current;
        await controller.deleteRecovery(entry.id);
        if (lifecycle.current !== visit) return;
        if (entry.id === pendingId.current) {
          await resetAnswers();
          if (lifecycle.current !== visit) return;
          await loadSurvey(await syncStorage(controller, visit), visit);
        }
        if (lifecycle.current !== visit) return;
        setConfirmation(null);
        await syncStorage();
        await refreshRecoveries();
      },
    });
  const setSaving = (enabled) => {
    const action = async (visit) => {
      const controller = storage.current;
      await controller.setMode(enabled ? "device" : "memory");
      await syncStorage(controller, visit);
      if (lifecycle.current === visit) setConfirmation(null);
    };
    if (enabled) runRecoveryAction(action);
    else
      setConfirmation({
        title: "停止设备保存",
        message:
          "将删除本次填写在设备上的草稿及待确认副本，其他记录会保留。当前答案只在本页内存中，刷新或关闭后无法恢复。待确认答卷可能已经在服务器保存；关闭本机保存不会撤销提交。建议先下载当前答案。",
        confirmLabel: "停止保存并删除本次本机记录",
        action,
        download: true,
      });
  };
  const reloadSurvey = () =>
    runRecoveryAction(async () => {
      const visit = lifecycle.current;
      const generation = ++definitionGeneration.current;
      const current = await requestDefinition();
      if (
        lifecycle.current !== visit ||
        definitionGeneration.current !== generation
      )
        return;
      const previous = { survey, answers: structuredClone(answersRef.current) };
      const clean = pruneSurveyAnswers(
        current,
        unchangedAnswers(survey, current, answersRef.current),
      );
      setPreviousCopy(previous);
      if (!keyConflict) submissionKey.current = newSubmissionKey();
      attempt.current = null;
      pendingId.current = null;
      setCurrentSurvey(current);
      setCurrentAnswers(clean);
      setSection(0);
      setFieldErrors({});
      setError("");
      setVersionConflict(false);
      setUncertain(false);
      setLoadFailed(false);
      await storeDraft(current, clean, keyConflict);
    });
  const beginAfterConflict = () =>
    setConfirmation({
      title: "开始新一次填写",
      message:
        "将保留当前答案并生成新的提交标识，不会自动提交。此前的标识可能已对应另一份答卷，再次提交会新增答卷并计入统计。请确认后再继续。",
      confirmLabel: "确认开始新一次填写",
      download: true,
      action: async () => {
        submissionKey.current = newSubmissionKey();
        attempt.current = null;
        pendingId.current = null;
        setKeyConflict(false);
        setError("");
        setConfirmation(null);
        await storeDraft(survey, answersRef.current);
      },
    });
  const loadResults = async () => {
    setResultsError("");
    const visit = lifecycle.current;
    try {
      const result = await api(
        "/surveys/" + encodeURIComponent(id) + "/results",
      );
      if (lifecycle.current === visit) setResults(result);
    } catch {
      if (lifecycle.current === visit)
        setResultsError("回答已保存，统计暂时无法加载。");
    }
  };

  const automaticRecovery = !(storageState?.limitations || []).some((item) =>
    ["LOCKS_UNAVAILABLE", "SESSION_UNAVAILABLE"].includes(item.code),
  );
  const recoveryControls = !preview && !success && (
    <section className="survey-recovery-controls" aria-label="填写进度与恢复">
      <label className="survey-save-choice">
        <input
          type="checkbox"
          checked={storageState?.mode !== "memory"}
          disabled={busy || !storageState}
          onChange={(event) => setSaving(event.target.checked)}
        />
        在此设备保存填写进度
      </label>
      <p className="fine">
        {storageState?.mode === "memory"
          ? "本次答案仅保留在当前页内存；刷新或关闭后无法恢复。"
          : `${automaticRecovery ? "本标签页刷新后自动恢复；其他标签页的记录需主动选择。" : "当前浏览器无法保证刷新后自动恢复，请从本机恢复列表选择自己的记录。"}普通草稿保留到最后修改后 7 天，待确认提交保留到确认或主动删除。`}
      </p>
      {(storageState?.limitations || []).map((limitation, index) => (
        <p key={index} className="draft-note" role="status">
          {typeof limitation === "string" ? limitation : limitation.message}
        </p>
      ))}
      <div className="survey-recovery-actions">
        <button
          type="button"
          className="quiet"
          disabled={busy}
          aria-expanded={showRecoveries}
          onClick={() => {
            setShowRecoveries(!showRecoveries);
            refreshRecoveries().catch((e) => setError(e.message));
          }}
        >
          恢复本机填写记录{recoveries.length ? `（${recoveries.length}）` : ""}
        </button>
        {Object.keys(answers).length > 0 && (
          <button type="button" className="quiet" onClick={downloadCurrent}>
            下载当前答案
          </button>
        )}
        {!uncertain &&
          !keyConflict &&
          !versionConflict &&
          Object.keys(answers).length > 0 && (
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={askClear}
            >
              清除当前答案
            </button>
          )}
        {uncertain && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() =>
              askDelete({ id: pendingId.current, kind: "pending" })
            }
          >
            删除本次恢复记录
          </button>
        )}
      </div>
      {showRecoveries && (
        <div className="survey-recovery-list" aria-label="可恢复的填写记录">
          {!recoveries.length && <p className="fine">没有其他可恢复的记录。</p>}
          {recoveries.map((entry) => (
            <article key={entry.id} data-recovery-id={entry.id}>
              <p>
                <strong>
                  {entry.kind === "pending"
                    ? "提交结果待确认"
                    : entry.kind === "legacy"
                      ? "旧版填写记录"
                      : "未提交草稿"}
                </strong>
                <br />
                {entry.updatedAt &&
                Number.isFinite(new Date(entry.updatedAt).getTime()) ? (
                  <time dateTime={new Date(entry.updatedAt).toISOString()}>
                    {new Date(entry.updatedAt).toLocaleString("zh-CN")}
                  </time>
                ) : (
                  "保存时间未知"
                )}
              </p>
              {entry.notice && <p className="fine">{entry.notice}</p>}
              {entry.downloadOnly && (
                <p className="fine">
                  缺少原题目定义，仅可下载核对，不会套用到当前问卷。
                </p>
              )}
              <div className="survey-recovery-actions">
                {!entry.downloadOnly && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy || uncertain}
                    onClick={() => restoreRecord(entry)}
                  >
                    恢复此记录
                  </button>
                )}
                <button
                  type="button"
                  className="quiet"
                  onClick={() => downloadRecord(entry)}
                >
                  下载此记录
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => askDelete(entry)}
                >
                  删除此记录
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
  const confirmDialog = confirmation && (
    <RecoveryConfirmation
      {...confirmation}
      busy={busy}
      onCancel={() => setConfirmation(null)}
      onDownload={confirmation.download ? downloadCurrent : undefined}
      onConfirm={() => runRecoveryAction(confirmation.action)}
    />
  );
  if (!survey)
    return (
      <div className="page survey-state">
        {!standalone && (
          <a className="back" href="/?page=you">
            <ArrowLeft /> 返回问卷
          </a>
        )}
        <section role={error ? "alert" : "status"}>
          {error && <h1>问卷暂时无法填写</h1>}
          <p>{error || "正在打开问卷…"}</p>
        </section>
        {loadFailed && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={retryLoad}
          >
            重新加载问卷
          </button>
        )}
        {recoveryControls}
        {confirmDialog}
      </div>
    );

  const { questions, termination } = surveyFlow(survey, answers);
  const progress = surveyAnswerProgress(survey, answers);
  const sections = surveySections(questions);
  const current = Math.min(section, Math.max(0, sections.length - 1));
  const active = sections[current]?.questions || [];
  const lastSection = current >= sections.length - 1;
  const locked =
    busy || uncertain || versionConflict || keyConflict || loadFailed;
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
    const next = sections.findIndex((group) =>
      group.questions.some((q) => q.id === first.id),
    );
    if (next >= 0) setSection(next);
    requestAnimationFrame(() =>
      document.getElementById(`question-${first.id}`)?.focus(),
    );
    return false;
  };
  async function submit(event) {
    event.preventDefault();
    if (inflight.current || versionConflict || keyConflict || loadFailed)
      return;
    setError("");
    if (!attempt.current && !lastSection) {
      if (check(active)) goToSection(current + 1);
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
    const visit = lifecycle.current,
      controller = storage.current;
    try {
      if (!attempt.current) {
        const pending = await controller.freezePending({
          body: {
            answers: pruneSurveyAnswers(survey, answersRef.current),
            definitionVersion: survey.definitionVersion,
            submissionKey: submissionKey.current || newSubmissionKey(),
          },
          surveySnapshot: survey,
        });
        if (lifecycle.current !== visit) return;
        attempt.current = pending.body;
        pendingId.current = pending.id;
        await syncStorage(controller, visit);
      }
      const result = await api(
        "/surveys/" + encodeURIComponent(id) + "/submit",
        { method: "POST", body: attempt.current },
      );
      if (lifecycle.current !== visit) return;
      if (!result || !["completed", "terminated"].includes(result.completion))
        throw Object.assign(
          new Error("服务器未返回有效的提交确认，请重试确认本次提交。"),
          { code: "INVALID_RESPONSE" },
        );
      await controller.confirmPending(pendingId.current);
      if (lifecycle.current !== visit) return;
      attempt.current = null;
      pendingId.current = null;
      setUncertain(false);
      setSuccess({
        message: result.message || "回答已保存。",
        completion: result.completion,
        termination: result.termination,
      });
      await syncStorage(controller, visit);
      await refreshRecoveries(controller, visit);
      if (lifecycle.current !== visit) return;
      onSubmissionSuccess?.(id, result);
      if (survey.publicResults) await loadResults();
    } catch (e) {
      if (lifecycle.current !== visit) return;
      setError(e.message);
      const unknown =
        e.code === "INVALID_RESPONSE" ||
        !e.status ||
        e.status >= 500 ||
        e.status === 429 ||
        e.status === 408;
      setUncertain(unknown && Boolean(attempt.current));
      if (!unknown) {
        try {
          await controller.deleteRecovery(pendingId.current);
        } catch (cleanupError) {
          if (lifecycle.current !== visit) return;
          setUncertain(Boolean(attempt.current));
          setError(
            `${e.message}；本机提交恢复记录未能清理，原请求继续保持锁定。${cleanupError.message}`,
          );
          return;
        }
        if (lifecycle.current !== visit) return;
        attempt.current = null;
        pendingId.current = null;
        try {
          await storeDraft(
            survey,
            answersRef.current,
            e.code === "SUBMISSION_KEY_CONFLICT",
          );
        } catch (storageError) {
          if (lifecycle.current !== visit) return;
          setError(
            `${e.message}；本机草稿暂时无法更新，当前答案仍保留在本页。${storageError.message}`,
          );
        }
        if (lifecycle.current !== visit) return;
      }
      if (e.code === "SURVEY_VERSION_CONFLICT") setVersionConflict(true);
      if (e.code === "SUBMISSION_KEY_CONFLICT") setKeyConflict(true);
    } finally {
      if (lifecycle.current === visit) {
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
        {preview
          ? "PREVIEW / 预览"
          : standalone
            ? "QUESTIONNAIRE / 问卷"
            : "ABOUT YOU / 关于你"}
      </span>
      <h1>{survey.title}</h1>
      <p className="survey-description">{survey.description}</p>
      {success ? (
        <div className="success" role="status">
          <Check size={36} />
          <h2>{success.message}</h2>
          {(storageState?.limitations || [])
            .filter((item) =>
              [
                "DELETE_FAILED",
                "LEGACY_SOURCE_REMAINS",
                "OTHER_COPIES_REMAIN",
              ].includes(item.code),
            )
            .map((item) => (
              <p className="draft-note" key={item.code}>
                {item.message}
              </p>
            ))}
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
          <button className="quiet" disabled={busy} onClick={askClear}>
            重新填写
          </button>
        </div>
      ) : (
        <form
          onSubmit={submit}
          noValidate
          inert={confirmation ? true : undefined}
        >
          {recoveryControls}
          {versionConflict && (
            <section className="module-recovery" role="alert">
              <p>
                问卷已经更新，当前答案仍保留。加载新版后，只有题目定义未变化的答案会保留，其他题目请重新确认。
              </p>
              <button type="button" className="quiet" onClick={downloadCurrent}>
                下载当前填写副本
              </button>{" "}
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={reloadSurvey}
              >
                加载最新问卷
              </button>
            </section>
          )}
          {keyConflict && (
            <section className="module-recovery" role="alert">
              <p>
                此提交标识已用于其他内容。当前答案已保留；开始新一次填写后再次提交可能新增一份统计记录，不会自动提交。
              </p>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={beginAfterConflict}
              >
                保留当前答案，开始新一次填写
              </button>
            </section>
          )}
          {loadFailed && (
            <section className="module-recovery" role="alert">
              <p>
                暂时无法取得问卷。当前答案与恢复记录仍保留，请重试或下载副本。
              </p>
              <button type="button" className="quiet" onClick={downloadCurrent}>
                下载当前填写副本
              </button>{" "}
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={retryLoad}
              >
                重新加载问卷
              </button>
            </section>
          )}
          {previousCopy && (
            <p className="draft-note">
              已加载最新问卷，请确认变更的题目。{" "}
              <button
                type="button"
                onClick={() =>
                  downloadAnswerCopy(previousCopy.survey, previousCopy.answers)
                }
              >
                下载更新前的填写副本
              </button>
            </p>
          )}
          {uncertain && (
            <p className="draft-note" role="status">
              上一次提交结果尚未确认。重试会确认同一次提交，不会重复保存。确认前不能修改答案；可以下载答案或明确删除本机恢复记录。
            </p>
          )}
          {storageState?.draft && !uncertain && (
            <p className="draft-note">
              {storageState.mode === "device"
                ? `已保存本次本机草稿 · ${automaticRecovery ? "本标签页刷新后可继续" : "刷新后请主动选择恢复记录"}`
                : "当前答案仅在本页内存中"}
            </p>
          )}
          {progress.total > 0 && (
            <div
              className="survey-progress"
              role="progressbar"
              aria-label="必答项填写进度"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.answered}
              aria-valuetext={`已填写 ${progress.answered} / ${progress.total} 项必答项，${progress.percent}%，尚未提交`}
            >
              <div style={{ width: progress.percent + "%" }} />
            </div>
          )}
          <p className="fine survey-progress-caption" role="status">
            {termination
              ? "已触发结束条件，待提交"
              : progress.total
                ? `已填写 ${progress.answered} / ${progress.total} 项必答项 · ${progress.percent}%${progress.answered === progress.total ? " · 待提交" : ""}`
                : "全部为选填，可直接提交"}
          </p>
          <div className="section-head">
            <h2 ref={sectionHeading} tabIndex={-1}>
              {sections[current]?.title || "问题"}
            </h2>
            <span className="mono">
              第 {current + 1} / {Math.max(1, sections.length)} 部分
            </span>
          </div>
          <fieldset className="survey-active-section" disabled={locked}>
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
                disabled={locked}
                onClick={() => {
                  goToSection(current - 1);
                  setError("");
                }}
              >
                <ArrowLeft /> 上一部分
              </button>
            )}
            <button
              className="button"
              disabled={busy || versionConflict || keyConflict || loadFailed}
            >
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
      {confirmDialog}
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
