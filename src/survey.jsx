import React, { useState, useEffect } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Check,
} from "@phosphor-icons/react";
import { api } from "./api";
import { visibleQuestions } from "../server/validation.js";
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
}) {
  const values = Array.isArray(value) ? value : [];
  const toggle = (o) =>
    onChange(
      values.includes(o) ? values.filter((x) => x !== o) : [...values, o],
    );
  return (
    <fieldset className="survey-question">
      <legend>
        {q.title}
        {q.required && <span className="required"> *</span>}
      </legend>
      {q.description && <p>{q.description}</p>}
      {(q.min || q.max) && (
        <p className="fine">
          {q.min ? `至少${q.min}项 ` : ""}
          {q.max ? `最多${q.max}项` : ""}
        </p>
      )}
      {q.type === "text" ? (
        <textarea
          aria-label={q.title}
          rows={4}
          maxLength={10000}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="写下你的回答…"
        />
      ) : q.type === "rank" ? (
        <>
          <p className="fine">
            拖动排序，或使用上下箭头。请先点击确认初始顺序，或调整顺序。
          </p>
          {!value && (
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
            value={value || q.options}
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
                <span>{o}</span>
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
                  value={otherValue || ""}
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
    </fieldset>
  );
}
export default function Survey({ id, preview }) {
  const [survey, setSurvey] = useState(preview || null),
    [answers, setAnswers] = useState({}),
    [section, setSection] = useState(0),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false),
    [results, setResults] = useState(null),
    [draft, setDraft] = useState(false);
  useEffect(() => {
    if (preview) {
      setSurvey(preview);
      return;
    }
    let active = true;
    api("/surveys/" + id)
      .then((s) => {
        if (!active) return;
        setSurvey(s);
        try {
          const stored = JSON.parse(
            localStorage.getItem("survey-" + id) || "null",
          );
          if (stored && stored.revision === s.updatedAt) {
            setAnswers(stored.answers);
            setDraft(true);
          }
        } catch {}
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [id, preview]);
  const change = (key, value) => {
    const a = { ...answers, [key]: value };
    setAnswers(a);
    if (!preview) {
      localStorage.setItem(
        "survey-" + id,
        JSON.stringify({ revision: survey.updatedAt, answers: a }),
      );
      setDraft(true);
    }
  };
  if (!survey)
    return (
      <div className="page">
        <a className="back" href="/?page=you">
          <ArrowLeft /> 返回问卷
        </a>
        <p>{error || "正在打开问卷…"}</p>
      </div>
    );
  const questions = visibleQuestions(survey, answers);
  const sections = [...new Set(questions.map((q) => q.section || "问题"))];
  const current = Math.min(section, Math.max(0, sections.length - 1));
  const active = questions.filter(
    (q) => (q.section || "问题") === sections[current],
  );
  const check = (qs) => {
    for (const q of qs) {
      const a = answers[q.id];
      if (
        q.required &&
        (a == null || a === "" || (Array.isArray(a) && !a.length))
      )
        return `请回答：${q.title}`;
      if (
        Array.isArray(a) &&
        ((q.min && a.length < q.min) || (q.max && a.length > q.max))
      )
        return `请检查选择数量：${q.title}`;
    }
    return "";
  };
  async function submit(e) {
    e.preventDefault();
    setError("");
    if (current < sections.length - 1) {
      const err = check(active);
      if (err) return setError(err);
      setSection(current + 1);
      return;
    }
    const err = check(questions);
    if (err) return setError(err);
    if (preview) return setSuccess("预览完成，未保存答卷。");
    setBusy(true);
    try {
      const r = await api("/surveys/" + id + "/submit", {
        method: "POST",
        body: { answers },
      });
      setSuccess(r.message);
      localStorage.removeItem("survey-" + id);
      if (survey.publicResults)
        setResults(await api("/surveys/" + id + "/results"));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={preview ? "survey-preview" : "reading survey-page"}>
      {!preview && (
        <a className="back" href="/?page=you">
          <ArrowLeft /> 返回问卷
        </a>
      )}
      <span className="eyebrow">
        {preview ? "PREVIEW / 预览" : "ABOUT YOU / 关于你"}
      </span>
      <h1>{survey.title}</h1>
      <p className="survey-description">{survey.description}</p>
      {success ? (
        <div className="success">
          <Check size={36} />
          <h2>{success}</h2>
          {results && (
            <>
              <p>共有 {results.count} 份回答</p>
              {results.summary
                .filter((q) => q.counts)
                .map((q) => (
                  <div className="result-block" key={q.id}>
                    <h3>{q.title}</h3>
                    {Object.entries(q.counts).map(([k, v]) => (
                      <p key={k}>
                        {k}：{v}
                      </p>
                    ))}
                  </div>
                ))}
            </>
          )}
          <button
            className="quiet"
            onClick={() => {
              setSuccess("");
              setAnswers({});
              setSection(0);
              setDraft(false);
            }}
          >
            重新填写
          </button>
        </div>
      ) : (
        <form onSubmit={submit}>
          {draft && (
            <p className="draft-note">
              已保存本机草稿 · 刷新后可继续{" "}
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem("survey-" + id);
                  setAnswers({});
                  setDraft(false);
                }}
              >
                清除
              </button>
            </p>
          )}
          <div className="survey-progress">
            <div
              style={{
                width:
                  ((current + 1) / Math.max(1, sections.length)) * 100 + "%",
              }}
            />
          </div>
          <div className="section-head">
            <h2>{sections[current]}</h2>
            <span className="mono">
              {current + 1} / {sections.length}
            </span>
          </div>
          {active.map((q) => (
            <QuestionInput
              key={q.id}
              q={q}
              value={answers[q.id]}
              onChange={(v) => change(q.id, v)}
              otherValue={answers[q.id + "__other"]}
              onOtherChange={(v) => change(q.id + "__other", v)}
            />
          ))}
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
                onClick={() => setSection(current - 1)}
              >
                <ArrowLeft /> 上一部分
              </button>
            )}
            <button className="button" disabled={busy}>
              {busy
                ? "正在保存…"
                : current < sections.length - 1
                  ? "下一部分"
                  : "提交回答"}
              <ArrowRight />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
