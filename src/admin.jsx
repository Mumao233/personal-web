import React, { useEffect, useState, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Plus,
  Trash,
  FloppyDisk,
  Eye,
  SignOut,
  Check,
  ArrowUp,
  ArrowDown,
  X,
  UploadSimple,
} from "@phosphor-icons/react";
import { api, date } from "./api";
import { isRevisionConflict } from "./editor-state";
import { ConflictRecovery, useLeaveGuard } from "./editor-recovery";
import Survey from "./survey";
import RichEditor from "./rich-editor";
import ArticleContent from "./article-content";
import useDraftPublishing from "./use-draft-publishing";
import { ProfileFieldsEditor } from "./profile-fields";
import { PhotoWorkbench, ProjectAttachments } from "./media-workbench";
import StoryLocationFields from "./story-location-fields";
import { storyPublicationProblem } from "./media-workbench-state";
import { publicContent } from "../server/content.js";
import { calendarDateAt } from "../shared/content-date.js";
import { surveyVisitUrl } from "../shared/page-info.js";
import {
  normalizeSurveyDefinition,
  surveyDefinitionIssues,
  splitOptionLines,
} from "../shared/survey-definition.js";
import {
  exclusiveOptionsFor,
  summarizeSurvey,
  surveyCompletionCounts,
} from "../server/validation.js";
import "./publishing.css";
import "./survey-admin.css";
import ThemeToggle from "./theme.jsx";
const labels = {
  profile: "个人资料",
  projects: "作品与项目",
  posts: "随笔",
  stories: "关于世界",
  surveys: "问卷",
  messages: "问答",
  notifications: "通知与设置",
};
function localTime(v) {
  if (!v) return "";
  if (!v.endsWith("Z")) return v;
  const d = new Date(v);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
const newContent = (kind) => ({
  id: "new",
  revision: 0,
  title: "",
  body: "",
  published: false,
  cover: "",
  link: "",
  category: "",
  status: "",
  excerpt: "",
  date: "",
  dateMode: "auto",
  location: "",
  city: "",
  lat: "",
  lng: "",
  cityLat: "",
  cityLng: "",
  publicLocation: "",
  locationPrecision: kind === "stories" ? "city" : undefined,
  photos: [],
  photoDetails: kind === "stories" ? [] : undefined,
  attachments: kind === "projects" ? [] : undefined,
  description: "",
  questions: kind === "surveys" ? [newQuestion()] : [],
  closed: false,
  publicResults: false,
  successMessage: "谢谢，你的回答已被保存。",
  terminationMessage: "感谢你的参与，本次问卷到这里结束。",
  startsAt: "",
  endsAt: "",
});
const newQuestion = () => ({
  id: crypto.randomUUID(),
  title: "",
  type: "single",
  options: ["选项一", "选项二"],
  required: true,
  section: "",
  description: "",
  min: 0,
  max: 0,
  condition: null,
  rows: [],
  terminateOptions: [],
  exclusiveOptions: [],
});
const likertOptions = [
  "非常不同意",
  "比较不同意",
  "既不赞同也不反对",
  "比较同意",
  "非常同意",
];
const choiceTypes = ["single", "multiple", "rank", "multirank"];
const terminatingTypes = ["single", "multiple", "multirank"];
const exclusiveTypes = ["multiple", "multirank"];
const questionOptions = (question) => [
  ...new Set([
    ...(question.options || []).filter((option) => option.trim()),
    ...(question.allowOther ? ["其他"] : []),
  ]),
];
function newMatrixQuestion(example = false) {
  const statements = example
    ? [
        "我感到自己可支配的生活资金比较紧张。",
        "我担心自己的资金不足以支付日常开销。",
        "我难以负担一些对自己重要的消费。",
        "我希望通过兼职或其他方式，增加自己可支配的生活费。",
      ]
    : ["", ""];
  return {
    ...newQuestion(),
    type: "matrix",
    title: example ? "请根据你的实际情况，选择对以下陈述的认同程度。" : "",
    options: [...likertOptions],
    rows: statements.map((title) => ({ id: crypto.randomUUID(), title })),
  };
}
function Field({ label, value, onChange, type = "text", ...props }) {
  return (
    <label>
      {label}
      {type === "textarea" ? (
        <textarea
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          {...props}
        />
      ) : (
        <input
          type={type}
          value={value ?? ""}
          onChange={(e) =>
            onChange(
              type === "number" ? Number(e.target.value) : e.target.value,
            )
          }
          {...props}
        />
      )}
    </label>
  );
}
function Toggle({ label, value, onChange, ...props }) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        {...props}
      />
      {label}
    </label>
  );
}
export function SurveyLinks({ id }) {
  const [message, setMessage] = useState("");
  const [fallback, setFallback] = useState("");
  async function copy(standalone) {
    const link = new URL(surveyVisitUrl(id, standalone), window.location.origin)
      .href;
    try {
      await navigator.clipboard.writeText(link);
      setFallback("");
      setMessage(standalone ? "已复制独立填写链接" : "已复制普通访问链接");
    } catch {
      setFallback(link);
      setMessage("未能自动复制，请选择下方链接后复制。");
    }
  }
  return (
    <div className="survey-share-links">
      <div>
        <button type="button" onClick={() => copy(false)}>
          复制普通访问链接
        </button>
        <button type="button" onClick={() => copy(true)}>
          复制独立填写链接
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {fallback && (
        <input
          aria-label="待复制的问卷链接"
          readOnly
          value={fallback}
          onFocus={(event) => event.target.select()}
        />
      )}
    </div>
  );
}
export default function Admin() {
  const leaveEditor = useRef(null);
  const [state, setState] = useState(null),
    [setup, setSetup] = useState(false),
    [login, setLogin] = useState({ username: "", password: "" }),
    [tab, setTab] = useState("profile"),
    [editor, setEditor] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setState(await api("/admin"));
    } catch {
      setState(false);
      const s = await api("/status");
      setSetup(s.needsSetup);
    }
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  async function attempt(fn, message = "已保存") {
    setError("");
    setBusy(true);
    try {
      await fn();
      await load();
      setNotice(message);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (state === null) return <div className="loading">正在打开管理空间…</div>;
  if (state === false)
    return (
      <div className="admin-login">
        <ThemeToggle className="admin-login-theme" />
        <a className="back" href="/">
          <ArrowLeft /> 回到网站
        </a>
        <span className="eyebrow">PERSONAL SPACE / ADMIN</span>
        <h1>{setup ? "建立你的管理账号" : "欢迎回来。"}</h1>
        <p>
          {setup
            ? "首次设置仅可在服务器本地完成。请设置至少12位密码。"
            : "登录后，继续整理这个空间。"}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            attempt(
              () =>
                api(setup ? "/setup" : "/login", {
                  method: "POST",
                  body: login,
                }),
              "已登录",
            );
          }}
        >
          <Field
            label="用户名"
            value={login.username}
            onChange={(v) => setLogin({ ...login, username: v })}
            autoComplete="username"
            required
          />
          <Field
            label="密码"
            type="password"
            value={login.password}
            onChange={(v) => setLogin({ ...login, password: v })}
            autoComplete={setup ? "new-password" : "current-password"}
            minLength={setup ? 12 : 1}
            required
          />
          {error && <p className="error">{error}</p>}
          <button className="button" disabled={busy}>
            {busy ? "正在处理…" : setup ? "创建账号" : "登录"}
            <ArrowRight />
          </button>
        </form>
      </div>
    );
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <a
          className="wordmark"
          href="/"
          onClick={async (e) => {
            if (!leaveEditor.current) return;
            e.preventDefault();
            if (await leaveEditor.current()) window.location.assign("/");
          }}
        >
          林珈诚<span>YOUR PERSONAL SPACE</span>
        </a>
        <ThemeToggle className="admin-theme-toggle" label />
        <span className="eyebrow">管理空间</span>
        <nav>
          {Object.entries(labels).map(([k, v]) => (
            <button
              key={k}
              className={tab === k ? "active" : ""}
              onClick={async () => {
                if (leaveEditor.current && !(await leaveEditor.current()))
                  return;
                setTab(k);
                setEditor(null);
                setError("");
                load();
              }}
            >
              {v}
              {k === "messages" && (
                <small>{state.messages.filter((m) => !m.reply).length}</small>
              )}
            </button>
          ))}
        </nav>
        <a href="/" target="_blank" className="text-link">
          查看网站 <ArrowUpRight />
        </a>
        <button
          className="quiet"
          onClick={async () => {
            if (leaveEditor.current && !(await leaveEditor.current())) return;
            if (
              await attempt(() => api("/logout", { method: "POST" }), "已退出")
            ) {
              setEditor(null);
              setTab("profile");
              setLogin({ username: "", password: "" });
            }
          }}
        >
          <SignOut /> 退出
        </button>
      </aside>
      <main className="admin-main">
        <div className="admin-heading">
          <div>
            <span className="eyebrow">MAKE ROOM FOR SOMETHING NEW</span>
            <h1>{labels[tab]}</h1>
          </div>
          {["projects", "posts", "stories", "surveys"].includes(tab) &&
            !editor && (
              <button
                className="button"
                onClick={() => setEditor(newContent(tab))}
              >
                <Plus /> 新建
              </button>
            )}
        </div>
        {error && (
          <p className="error banner" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            <Check />
            {notice}
          </p>
        )}
        {tab === "profile" && (
          <Profile
            data={state.profile}
            busy={busy}
            leaveEditor={leaveEditor}
            save={async (b) => {
              const result = await api("/admin/profile", {
                method: "PUT",
                body: b,
              });
              await load();
              setNotice("资料已保存");
              return result.profile;
            }}
          />
        )}
        {["projects", "posts", "stories", "surveys"].includes(tab) &&
          (editor ? (
            <ContentEditor
              key={tab + editor.id}
              kind={tab}
              item={editor}
              busy={busy}
              leaveEditor={leaveEditor}
              close={() => {
                setEditor(null);
                load();
              }}
              save={async (b) => {
                const result = await api("/admin/" + tab + "/" + b.id, {
                  method: "PUT",
                  body: b,
                });
                await load();
                setNotice("问卷已保存");
                return result;
              }}
            />
          ) : (
            <div className="admin-list">
              {state[tab].length ? (
                state[tab].map((x) => (
                  <div className="admin-list-row" key={x.id}>
                    <div>
                      <span className="eyebrow">
                        {x.published
                          ? x.draft
                            ? "已发布 · 有未发布修改"
                            : "已发布"
                          : "草稿"}
                        {x.closed ? " · 已关闭" : ""}
                      </span>
                      <h3>{x.draft?.title || x.title || "未命名草稿"}</h3>
                      <p>
                        {date(x.draftSavedAt || x.updatedAt || x.createdAt)}
                      </p>
                      {tab === "surveys" && <SurveyLinks id={x.id} />}
                    </div>
                    <div className="row-actions">
                      <button onClick={() => setEditor(x)}>编辑</button>
                      {tab === "surveys" && (
                        <button
                          onClick={() => setEditor({ ...x, showResults: true })}
                        >
                          答卷与统计
                        </button>
                      )}
                      <button
                        className="danger"
                        aria-label={"删除 " + x.title}
                        onClick={() => {
                          if (confirm("删除这项内容？"))
                            attempt(
                              () =>
                                api("/admin/" + tab + "/" + x.id, {
                                  method: "DELETE",
                                }),
                              "已删除",
                            );
                        }}
                      >
                        <Trash />
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">
                  <h3>还没有内容。</h3>
                  <p>从右上角新建，保存为草稿或直接发布。</p>
                </div>
              )}
            </div>
          ))}
        {tab === "messages" && <Messages state={state} attempt={attempt} />}
        {tab === "notifications" && (
          <Notifications state={state} busy={busy} attempt={attempt} />
        )}
      </main>
    </div>
  );
}
export function Profile({ data, save, busy, leaveEditor }) {
  const [b, setB] = useState(() => ({ revision: 0, ...data })),
    [uploading, setUploading] = useState(false),
    [err, setErr] = useState(""),
    [saving, setSaving] = useState(false),
    [conflict, setConflict] = useState(false);
  const initial = useRef(JSON.stringify({ revision: 0, ...data }));
  const saveLock = useRef(false);
  const set = (k, v) => setB((previous) => ({ ...previous, [k]: v }));
  async function submit() {
    if (saveLock.current || uploading || conflict) return false;
    saveLock.current = true;
    setSaving(true);
    setErr("");
    try {
      const result = await save(b);
      initial.current = JSON.stringify(result);
      setB(result);
      return true;
    } catch (error) {
      setErr(error.message);
      setConflict(isRevisionConflict(error));
      return false;
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  const guard = useLeaveGuard({
    dirty: JSON.stringify(b) !== initial.current,
    blocked: saving || uploading,
    onSave: submit,
  });
  useEffect(() => {
    if (!leaveEditor) return;
    leaveEditor.current = guard.request;
    return () => {
      leaveEditor.current = null;
    };
  });
  async function reload() {
    setSaving(true);
    try {
      const result = await api("/admin");
      const profile = { revision: 0, ...result.profile };
      initial.current = JSON.stringify(profile);
      setB(profile);
      setConflict(false);
      setErr("");
    } catch (error) {
      setErr(error.message);
    } finally {
      setSaving(false);
    }
  }
  async function portrait(e) {
    setUploading(true);
    try {
      const files = new FormData();
      files.append("files", e.target.files[0]);
      const r = await api("/admin/upload", { method: "POST", body: files });
      if (r.files[0]) set("portrait", r.files[0].url);
    } catch (e) {
      setErr(e.message);
    } finally {
      setUploading(false);
    }
  }
  return (
    <form
      className="editor-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {guard.dialog}
      {conflict && (
        <ConflictRecovery value={b} busy={saving} onReload={reload} />
      )}
      <fieldset className="editor-fields" disabled={saving || busy}>
        <ProfileFieldsEditor profile={b} onChange={setB} />
        <Field
          label="首页短介绍"
          type="textarea"
          value={b.intro}
          onChange={(v) => set("intro", v)}
          rows={3}
        />
        <Field
          label="个人自述"
          type="textarea"
          value={b.bio}
          onChange={(v) => set("bio", v)}
          rows={12}
        />
        <label>
          个人照片
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={uploading}
            onChange={portrait}
          />
        </label>
        {b.portrait && (
          <div className="uploaded-preview">
            <img src={b.portrait} alt="个人照片" />
            <button type="button" onClick={() => set("portrait", "")}>
              移除
            </button>
          </div>
        )}
        {err && <p className="error">{err}</p>}
        <h2>最近在关注</h2>
        {b.interests.map((x, i) => (
          <div className="repeater" key={i}>
            <Field
              label="标题"
              value={x.title}
              onChange={(v) =>
                set(
                  "interests",
                  b.interests.map((y, j) => (j === i ? { ...y, title: v } : y)),
                )
              }
            />
            <Field
              label="描述"
              value={x.text}
              onChange={(v) =>
                set(
                  "interests",
                  b.interests.map((y, j) => (j === i ? { ...y, text: v } : y)),
                )
              }
            />
            <Field
              label="状态"
              value={x.status}
              onChange={(v) =>
                set(
                  "interests",
                  b.interests.map((y, j) =>
                    j === i ? { ...y, status: v } : y,
                  ),
                )
              }
            />
            <button
              type="button"
              className="danger"
              onClick={() =>
                set(
                  "interests",
                  b.interests.filter((_, j) => j !== i),
                )
              }
            >
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="quiet"
          onClick={() =>
            set("interests", [
              ...b.interests,
              { title: "", text: "", status: "" },
            ])
          }
        >
          <Plus /> 添加关注
        </button>
        <h2>经历时间线</h2>
        {b.timeline.map((x, i) => (
          <div className="repeater" key={i}>
            {[
              ["date", "时间"],
              ["title", "名称"],
              ["text", "说明"],
            ].map(([k, l]) => (
              <Field
                key={k}
                label={l}
                value={x[k]}
                onChange={(v) =>
                  set(
                    "timeline",
                    b.timeline.map((y, j) => (j === i ? { ...y, [k]: v } : y)),
                  )
                }
              />
            ))}
            <button
              type="button"
              className="danger"
              onClick={() =>
                set(
                  "timeline",
                  b.timeline.filter((_, j) => j !== i),
                )
              }
            >
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="quiet"
          onClick={() =>
            set("timeline", [...b.timeline, { date: "", title: "", text: "" }])
          }
        >
          <Plus /> 添加经历
        </button>
        <Toggle
          label="接受新的提问"
          value={b.acceptQuestions}
          onChange={(v) => set("acceptQuestions", v)}
        />
        <button
          className="button"
          disabled={busy || saving || uploading || conflict}
        >
          <FloppyDisk /> {saving ? "正在保存…" : "保存资料"}
        </button>
      </fieldset>
    </form>
  );
}
export function ContentEditor({ kind, item, save, close, busy, leaveEditor }) {
  const [b, setB] = useState(() => ({
      ...newContent(kind),
      ...(item.id !== "new"
        ? {
            date: "",
            dateMode: undefined,
            locationPrecision: undefined,
            publicLocation: undefined,
          }
        : {}),
      ...item,
      ...item.draft,
    })),
    [preview, setPreview] = useState(false),
    [uploading, setUploading] = useState(false),
    [inlineUploading, setInlineUploading] = useState(false),
    [mediaUploading, setMediaUploading] = useState(false),
    [previewSize, setPreviewSize] = useState("desktop"),
    [error, setError] = useState("");
  const publisher = useDraftPublishing(
    kind,
    item,
    b,
    uploading || inlineUploading || mediaUploading,
  );
  const [surveySaving, setSurveySaving] = useState(false);
  const [surveyConflict, setSurveyConflict] = useState(false);
  const [surveyIssues, setSurveyIssues] = useState([]);
  const surveyChecked = useRef(false);
  const formRef = useRef(null);
  const [reloading, setReloading] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const surveySaved = useRef(JSON.stringify(b));
  const saveLock = useRef(false);
  useEffect(() => {
    if (kind !== "surveys") return;
    setPreview(false);
    if (surveyChecked.current)
      setSurveyIssues(surveyDefinitionIssues(normalizeSurveyDefinition(b)));
  }, [b, kind]);
  function focusSurveyIssue(issue) {
    const form = formRef.current;
    if (!form) return;
    const question = [...form.querySelectorAll("[data-question-id]")].find(
      (node) => node.dataset.questionId === issue.questionId,
    );
    const scope = question || form;
    const field = String(issue.field || "questions").split(/[.[]/)[0];
    const marker = [...scope.querySelectorAll("[data-survey-field]")].find(
      (node) =>
        node.dataset.surveyField ===
        (question ? field : issue.questionId ? "questions" : field),
    );
    const rowField =
      field === "rows" && Number.isInteger(issue.rowIndex)
        ? scope.querySelector(`[data-survey-row-index="${issue.rowIndex}"]`)
        : null;
    const target =
      rowField ||
      (marker?.matches("input, textarea, select, button, [tabindex]")
        ? marker
        : marker?.querySelector("input, textarea, select, button") ||
          question?.querySelector("input, textarea, select") ||
          form);
    for (let node = target; node && node !== form; node = node.parentElement)
      if (node.tagName === "DETAILS") node.open = true;
    target.scrollIntoView?.({ block: "center", behavior: "instant" });
    target.focus({ preventScroll: true });
  }
  function checkedSurvey() {
    const normalized = normalizeSurveyDefinition(b);
    const issues = surveyDefinitionIssues(normalized);
    surveyChecked.current = true;
    setSurveyIssues(issues);
    if (issues.length) {
      setPreview(false);
      setError("");
      return null;
    }
    return normalized;
  }
  function toggleSurveyPreview() {
    if (preview) setPreview(false);
    else if (checkedSurvey()) setPreview(true);
  }
  async function saveSurvey() {
    if (saveLock.current || surveyConflict) return false;
    const normalized = checkedSurvey();
    if (!normalized) return false;
    saveLock.current = true;
    setSurveySaving(true);
    setError("");
    try {
      const result = await save({
        ...normalized,
        revision: b.revision || 0,
        startsAt: b.startsAt ? new Date(b.startsAt).toISOString() : "",
        endsAt: b.endsAt ? new Date(b.endsAt).toISOString() : "",
      });
      surveySaved.current = JSON.stringify(result);
      setB(result);
      return true;
    } catch (error) {
      setError(error.message);
      if (Array.isArray(error.issues)) setSurveyIssues(error.issues);
      setSurveyConflict(isRevisionConflict(error));
      return false;
    } finally {
      saveLock.current = false;
      setSurveySaving(false);
    }
  }
  const guard = useLeaveGuard({
    dirty: kind === "surveys" && JSON.stringify(b) !== surveySaved.current,
    blocked: kind === "surveys" && surveySaving,
    onSave: saveSurvey,
  });
  const leave = kind === "surveys" ? guard.request : publisher.leave;
  useEffect(() => {
    leaveEditor.current = leave;
    return () => {
      leaveEditor.current = null;
    };
  });
  async function goBack() {
    if (await leave()) close();
  }
  async function reload() {
    setReloading(true);
    setError("");
    try {
      const record = await api(
        `/admin/${kind}/${kind === "surveys" ? b.id : publisher.meta.id}`,
      );
      const snapshot = {
        ...newContent(kind),
        date: "",
        dateMode: undefined,
        locationPrecision: undefined,
        publicLocation: undefined,
        ...record,
        ...record.draft,
      };
      if (kind === "surveys") {
        surveySaved.current = JSON.stringify(snapshot);
        setSurveyConflict(false);
        setSurveyIssues([]);
        surveyChecked.current = false;
      } else publisher.reset(record, snapshot);
      setB(snapshot);
      setEditorEpoch((epoch) => epoch + 1);
    } catch (error) {
      setError(error.message);
    } finally {
      setReloading(false);
    }
  }
  const set = (k, v) =>
    setB((prev) => ({
      ...prev,
      [k]: v,
    }));
  const updateQ = (i, key, v) =>
    setB((prev) => ({
      ...prev,
      questions: prev.questions.map((q, j) =>
        i === j ? { ...q, [key]: v } : q,
      ),
    }));
  function changeQuestionType(index, type) {
    setB((prev) => ({
      ...prev,
      questions: prev.questions.map((question, i) => {
        if (i !== index || question.type === type) return question;
        return {
          ...question,
          type,
          options:
            type === "matrix"
              ? [...likertOptions]
              : question.type === "text"
                ? ["选项一", "选项二"]
                : question.options,
          rows:
            type === "matrix"
              ? question.rows?.length
                ? question.rows
                : newMatrixQuestion().rows
              : [],
          allowOther: terminatingTypes.includes(type)
            ? !!question.allowOther
            : false,
          min: exclusiveTypes.includes(type) ? question.min || 0 : 0,
          max: exclusiveTypes.includes(type) ? question.max || 0 : 0,
        };
      }),
    }));
  }
  function toggleOptionRule(index, key, option, checked) {
    setB((prev) => ({
      ...prev,
      questions: prev.questions.map((question, i) =>
        i !== index
          ? question
          : {
              ...question,
              [key]: checked
                ? [...new Set([...(question[key] || []), option])]
                : (question[key] || []).filter((value) => value !== option),
            },
      ),
    }));
  }
  function addExclusiveNone(index) {
    setB((prev) => ({
      ...prev,
      questions: prev.questions.map((question, i) =>
        i !== index
          ? question
          : {
              ...question,
              options: questionOptions(question).includes("以上都无")
                ? question.options
                : [
                    ...(question.options || []).filter((option) =>
                      option.trim(),
                    ),
                    "以上都无",
                  ],
              exclusiveOptions: [
                ...new Set([...(question.exclusiveOptions || []), "以上都无"]),
              ],
            },
      ),
    }));
  }
  async function upload(e) {
    const selected = [...e.target.files];
    e.target.value = "";
    if (!selected.length) return;
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("files", selected[0]);
      const r = await api("/admin/upload", { method: "POST", body: form });
      if (!r.files.length) throw Error("请上传 JPG、PNG、WebP 或 GIF");
      set("cover", r.files[0].url);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }
  function publishContent() {
    if (kind === "stories") {
      const problem = storyPublicationProblem(b);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setError("");
    publisher.publish();
  }
  if (item.showResults) return <Results survey={item} close={close} />;
  return (
    <>
      <button className="back" onClick={goBack}>
        <ArrowLeft /> 返回列表
      </button>
      <form
        className="editor-form"
        ref={formRef}
        noValidate={kind === "surveys"}
        tabIndex={-1}
        onSubmit={(e) => {
          e.preventDefault();
          if (kind !== "surveys") {
            publishContent();
            return;
          }
          saveSurvey().then((saved) => {
            if (saved) close();
          });
        }}
      >
        {guard.dialog}
        {kind === "surveys" && surveyIssues.length > 0 && (
          <section
            className="survey-validation-errors"
            role="alert"
            aria-label="问卷校验错误"
          >
            <h2>有 {surveyIssues.length} 处需要修改</h2>
            <p>未保存的内容已保留。点击错误可定位到对应字段。</p>
            <ul>
              {surveyIssues.map((issue, index) => (
                <li
                  key={`${issue.questionId}:${issue.field}:${issue.code}:${index}`}
                >
                  <button type="button" onClick={() => focusSurveyIssue(issue)}>
                    {issue.message}
                    <small>
                      {issue.questionId
                        ? `题目 ID：${issue.questionId} · `
                        : ""}
                      字段：{issue.field}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(surveyConflict || publisher.conflict) && (
          <ConflictRecovery
            value={b}
            busy={
              reloading ||
              surveySaving ||
              publisher.saving ||
              !!publisher.action
            }
            onReload={reload}
            onDiscard={() => {
              publisher.discard();
              close();
            }}
          />
        )}
        <fieldset
          className="editor-fields"
          disabled={surveySaving || reloading || !!publisher.action}
          inert={
            publisher.action || reloading || surveySaving ? true : undefined
          }
        >
          <Field
            label="标题"
            data-survey-field="title"
            value={b.title}
            onChange={(v) => set("title", v)}
            required
          />
          {kind === "surveys" ? (
            <>
              {b.id !== "new" && <SurveyLinks id={b.id} />}
              <Field
                label="问卷说明"
                data-survey-field="description"
                type="textarea"
                rows={3}
                value={b.description}
                onChange={(v) => set("description", v)}
              />
              <div className="field-grid">
                <Field
                  label="开始时间（可留空）"
                  data-survey-field="startsAt"
                  type="datetime-local"
                  value={localTime(b.startsAt)}
                  onChange={(v) => set("startsAt", v)}
                />
                <Field
                  label="截止时间（可留空）"
                  data-survey-field="endsAt"
                  type="datetime-local"
                  value={localTime(b.endsAt)}
                  onChange={(v) => set("endsAt", v)}
                />
              </div>
              <div className="form-options">
                <Toggle
                  label="关闭问卷"
                  value={b.closed}
                  onChange={(v) => set("closed", v)}
                />
                <Toggle
                  label="提交后显示汇总结果（不公开文字回答）"
                  value={b.publicResults}
                  onChange={(v) => set("publicResults", v)}
                />
              </div>
              <Field
                label="提交成功提示"
                data-survey-field="successMessage"
                value={b.successMessage}
                onChange={(v) => set("successMessage", v)}
              />
              <Field
                label="提前结束提示"
                data-survey-field="terminationMessage"
                value={b.terminationMessage}
                onChange={(v) => set("terminationMessage", v)}
                placeholder="感谢你的参与，本次问卷到这里结束。"
              />
              <h2 data-survey-field="questions" tabIndex={-1}>
                题目编辑
              </h2>
              <p className="fine">
                按顺序展示；同名章节连续分组。可为选项设置提前结束或排他规则，矩阵题每行单选。
              </p>
              {b.questions.map((q, i) => (
                <section
                  className="question-editor"
                  key={q.id}
                  data-question-id={q.id}
                >
                  <div className="question-editor-head">
                    <span className="eyebrow">QUESTION {i + 1}</span>
                    <div>
                      <button
                        type="button"
                        disabled={!i}
                        aria-label="上移题目"
                        onClick={() => {
                          const a = [...b.questions];
                          [a[i - 1], a[i]] = [a[i], a[i - 1]];
                          set("questions", a);
                        }}
                      >
                        <ArrowUp />
                      </button>
                      <button
                        type="button"
                        disabled={i === b.questions.length - 1}
                        aria-label="下移题目"
                        onClick={() => {
                          const a = [...b.questions];
                          [a[i + 1], a[i]] = [a[i], a[i + 1]];
                          set("questions", a);
                        }}
                      >
                        <ArrowDown />
                      </button>
                      <button
                        type="button"
                        className="danger"
                        aria-label="删除题目"
                        onClick={() =>
                          set(
                            "questions",
                            b.questions.filter((_, j) => j !== i),
                          )
                        }
                      >
                        <Trash />
                      </button>
                    </div>
                  </div>
                  <div className="field-grid">
                    <Field
                      label="题目"
                      data-survey-field="title"
                      value={q.title}
                      onChange={(v) => updateQ(i, "title", v)}
                      required
                    />
                    <label>
                      题型
                      <select
                        data-survey-field="type"
                        value={q.type}
                        onChange={(e) => changeQuestionType(i, e.target.value)}
                      >
                        {[
                          ["single", "单选"],
                          ["multiple", "多选"],
                          ["rank", "全部排序"],
                          ["multirank", "多选后排序"],
                          ["matrix", "矩阵量表（每行单选）"],
                          ["text", "文字回答"],
                        ].map(([k, l]) => (
                          <option value={k} key={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <Field
                    label="补充说明"
                    value={q.description}
                    onChange={(v) => updateQ(i, "description", v)}
                  />
                  {q.type !== "text" && (
                    <Field
                      data-survey-field="options"
                      aria-invalid={
                        surveyIssues.some(
                          (issue) =>
                            issue.questionId === q.id &&
                            issue.field === "options",
                        ) || undefined
                      }
                      label={
                        q.type === "matrix"
                          ? "矩阵列选项（每行一个，从左到右）"
                          : "选项（每行一个）"
                      }
                      type="textarea"
                      rows={4}
                      value={(q.options || []).join("\n")}
                      onChange={(v) =>
                        updateQ(i, "options", splitOptionLines(v))
                      }
                    />
                  )}
                  {q.type !== "text" && (
                    <p className="fine">
                      空白行会在预览和保存时忽略；有效选项的文字和顺序保持不变，重复项需手动修改。
                    </p>
                  )}
                  {q.type === "matrix" && (
                    <div
                      className="matrix-question-builder"
                      data-survey-field="rows"
                    >
                      <div className="matrix-builder-heading">
                        <h3>陈述行</h3>
                        <button
                          type="button"
                          className="quiet"
                          onClick={() =>
                            updateQ(i, "options", [...likertOptions])
                          }
                        >
                          恢复五级认同选项
                        </button>
                      </div>
                      <p className="fine">
                        每个陈述占一行。调整顺序会保留行标识，已有答卷仍能对应原来的陈述。
                      </p>
                      {(q.rows || []).map((row, rowIndex) => (
                        <div className="matrix-builder-row" key={row.id}>
                          <span className="matrix-row-number">
                            {String(rowIndex + 1).padStart(2, "0")}
                          </span>
                          <Field
                            label={`陈述 ${rowIndex + 1}`}
                            data-survey-row-index={rowIndex}
                            value={row.title}
                            required
                            onChange={(title) =>
                              updateQ(
                                i,
                                "rows",
                                q.rows.map((candidate) =>
                                  candidate.id === row.id
                                    ? { ...candidate, title }
                                    : candidate,
                                ),
                              )
                            }
                          />
                          <div className="matrix-row-actions">
                            <button
                              type="button"
                              aria-label={`上移陈述 ${rowIndex + 1}`}
                              disabled={rowIndex === 0}
                              onClick={() => {
                                const rows = [...q.rows];
                                [rows[rowIndex - 1], rows[rowIndex]] = [
                                  rows[rowIndex],
                                  rows[rowIndex - 1],
                                ];
                                updateQ(i, "rows", rows);
                              }}
                            >
                              <ArrowUp />
                            </button>
                            <button
                              type="button"
                              aria-label={`下移陈述 ${rowIndex + 1}`}
                              disabled={rowIndex === q.rows.length - 1}
                              onClick={() => {
                                const rows = [...q.rows];
                                [rows[rowIndex + 1], rows[rowIndex]] = [
                                  rows[rowIndex],
                                  rows[rowIndex + 1],
                                ];
                                updateQ(i, "rows", rows);
                              }}
                            >
                              <ArrowDown />
                            </button>
                            <button
                              type="button"
                              aria-label={`删除陈述 ${rowIndex + 1}`}
                              className="danger"
                              onClick={() =>
                                updateQ(
                                  i,
                                  "rows",
                                  q.rows.filter(
                                    (candidate) => candidate.id !== row.id,
                                  ),
                                )
                              }
                            >
                              <Trash />
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="quiet"
                        onClick={() =>
                          updateQ(i, "rows", [
                            ...(q.rows || []),
                            { id: crypto.randomUUID(), title: "" },
                          ])
                        }
                      >
                        <Plus /> 添加陈述行
                      </button>
                    </div>
                  )}
                  <div className="field-grid">
                    <Field
                      label="所属章节（留空为“问题”）"
                      value={q.section}
                      onChange={(v) => updateQ(i, "section", v)}
                    />
                    {["multiple", "multirank"].includes(q.type) && (
                      <>
                        <Field
                          label="最少选择（0为不限）"
                          data-survey-field="min"
                          type="number"
                          min="0"
                          value={q.min}
                          onChange={(v) => updateQ(i, "min", v)}
                        />
                        <Field
                          label="最多选择（0为不限）"
                          data-survey-field="max"
                          type="number"
                          min="0"
                          value={q.max}
                          onChange={(v) => updateQ(i, "max", v)}
                        />
                      </>
                    )}
                  </div>
                  <Toggle
                    label="必答"
                    value={q.required}
                    onChange={(v) => updateQ(i, "required", v)}
                  />
                  {["single", "multiple", "multirank"].includes(q.type) && (
                    <Toggle
                      label="允许选择“其他”并补充文字"
                      data-survey-field="allowOther"
                      value={q.allowOther}
                      onChange={(v) => updateQ(i, "allowOther", v)}
                    />
                  )}
                  {terminatingTypes.includes(q.type) && (
                    <details className="option-rules-editor">
                      <summary>
                        选项规则 · 提前结束
                        {exclusiveTypes.includes(q.type) ? " / 排他选择" : ""}
                      </summary>
                      <p className="fine">
                        提前结束：选中后，本题之后的问题不再要求作答，确认提交后记录为“提前结束”。
                      </p>
                      {exclusiveTypes.includes(q.type) && (
                        <p className="fine">
                          排他选择：该选项只能单独选；选中时清除本题其他选择。它单独作答时不受最少选择数限制。
                        </p>
                      )}
                      {questionOptions(q).length ? (
                        <div className="option-rule-list">
                          {questionOptions(q).map((option) => (
                            <div className="option-rule-row" key={option}>
                              <strong>{option}</strong>
                              <label className="check">
                                <input
                                  data-survey-field="terminateOptions"
                                  type="checkbox"
                                  aria-label={`提前结束：${option}`}
                                  checked={(q.terminateOptions || []).includes(
                                    option,
                                  )}
                                  onChange={(event) =>
                                    toggleOptionRule(
                                      i,
                                      "terminateOptions",
                                      option,
                                      event.target.checked,
                                    )
                                  }
                                />
                                提前结束
                              </label>
                              {exclusiveTypes.includes(q.type) && (
                                <label className="check">
                                  <input
                                    data-survey-field="exclusiveOptions"
                                    type="checkbox"
                                    aria-label={`排他：${option}`}
                                    checked={exclusiveOptionsFor(q).includes(
                                      option,
                                    )}
                                    disabled={option === "以上都无"}
                                    onChange={(event) =>
                                      toggleOptionRule(
                                        i,
                                        "exclusiveOptions",
                                        option,
                                        event.target.checked,
                                      )
                                    }
                                  />
                                  排他{option === "以上都无" ? "（固定）" : ""}
                                </label>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="fine">先填写选项，再设置规则。</p>
                      )}
                      {exclusiveTypes.includes(q.type) && (
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => addExclusiveNone(i)}
                        >
                          <Plus /> 添加以上都无（排他）
                        </button>
                      )}
                      <p className="fine">
                        删除或重命名选项后，原有规则和跳题引用会保留；请先修复引用再保存。
                      </p>
                    </details>
                  )}
                  {["terminateOptions", "exclusiveOptions"].flatMap((key) =>
                    (q[key] || [])
                      .filter(
                        (option) =>
                          !(
                            key === "terminateOptions"
                              ? terminatingTypes
                              : exclusiveTypes
                          ).includes(q.type) ||
                          !questionOptions(q).includes(option),
                      )
                      .map((option) => (
                        <div
                          className="survey-stale-rule"
                          key={`${key}:${option}`}
                        >
                          <p>
                            {key === "terminateOptions"
                              ? "提前结束"
                              : "排他选择"}
                            规则“{option}
                            ”已无法对应当前题型或选项。请恢复原选项，或明确移除此规则。
                          </p>
                          <button
                            type="button"
                            data-survey-field={key}
                            onClick={() =>
                              toggleOptionRule(i, key, option, false)
                            }
                          >
                            移除失效
                            {key === "terminateOptions" ? "提前结束" : "排他"}
                            规则“{option}”
                          </button>
                        </div>
                      )),
                  )}
                  <details data-survey-field="condition">
                    <summary>条件显示 / 自动跳题</summary>
                    <label>
                      当之前的哪一题
                      <select
                        value={q.condition?.questionId || ""}
                        onChange={(e) =>
                          updateQ(
                            i,
                            "condition",
                            e.target.value
                              ? { questionId: e.target.value, value: "" }
                              : null,
                          )
                        }
                      >
                        <option value="">始终显示</option>
                        {q.condition?.questionId &&
                          !b.questions
                            .slice(0, i)
                            .some(
                              (x) =>
                                x.id === q.condition.questionId &&
                                choiceTypes.includes(x.type),
                            ) && (
                            <option value={q.condition.questionId}>
                              原引用题目已删除、后移或变更题型（
                              {q.condition.questionId}）
                            </option>
                          )}
                        {b.questions
                          .slice(0, i)
                          .filter((x) => choiceTypes.includes(x.type))
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.title || "未命名题目"}
                            </option>
                          ))}
                      </select>
                    </label>
                    {q.condition?.questionId && (
                      <label>
                        选中以下答案时，才显示本题
                        <select
                          value={q.condition.value}
                          onChange={(e) =>
                            updateQ(i, "condition", {
                              ...q.condition,
                              value: e.target.value,
                            })
                          }
                        >
                          <option value="">选择一个答案</option>
                          {q.condition.value &&
                            !questionOptions(
                              b.questions.find(
                                (x) => x.id === q.condition.questionId,
                              ) || {},
                            ).includes(q.condition.value) && (
                              <option value={q.condition.value}>
                                原选项已失效：{q.condition.value}
                              </option>
                            )}
                          {questionOptions(
                            b.questions.find(
                              (x) => x.id === q.condition.questionId,
                            ) || {},
                          ).map((o) => (
                            <option value={o} key={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </details>
                </section>
              ))}
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  set("questions", [...b.questions, newQuestion()])
                }
              >
                <Plus /> 添加题目
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  set("questions", [...b.questions, newMatrixQuestion(true)])
                }
              >
                <Plus /> 插入生活费感受矩阵示例
              </button>
              <button
                type="button"
                className="quiet"
                onClick={toggleSurveyPreview}
              >
                <Eye />
                {preview ? "关闭预览" : "预览问卷"}
              </button>
            </>
          ) : (
            <>
              <RichEditor
                key={editorEpoch}
                content={b.content}
                body={b.body}
                photos={kind === "stories" ? b.photos : []}
                onChange={(document) =>
                  setB((prev) => ({ ...prev, ...document }))
                }
                onUploadingChange={setInlineUploading}
              />
              {kind === "projects" && (
                <div className="field-grid">
                  <Field
                    label="分类"
                    value={b.category}
                    onChange={(v) => set("category", v)}
                  />
                  <Field
                    label="进度状态"
                    value={b.status}
                    onChange={(v) => set("status", v)}
                  />
                  <Field
                    label="项目链接"
                    type="url"
                    value={b.link}
                    onChange={(v) => set("link", v)}
                  />
                </div>
              )}
              {kind === "posts" && (
                <Field
                  label="列表摘要"
                  value={b.excerpt}
                  onChange={(v) => set("excerpt", v)}
                />
              )}
              <div className="content-date-settings">
                <Field
                  label={
                    kind === "stories"
                      ? "拍摄 / 旅行日期（未知可留空）"
                      : "内容日期（可手动指定）"
                  }
                  type="date"
                  value={calendarDateAt(
                    b.date ||
                      (b.dateMode === "auto" && publisher.meta.published
                        ? publisher.meta.date
                        : ""),
                  )}
                  onChange={(date) =>
                    setB((previous) => ({
                      ...previous,
                      date,
                      dateMode: "manual",
                    }))
                  }
                />
                {kind !== "stories" && (
                  <Toggle
                    label="首次发布时自动使用北京时间日期"
                    value={b.dateMode === "auto"}
                    onChange={(automatic) =>
                      setB((previous) => ({
                        ...previous,
                        dateMode: automatic ? "auto" : "manual",
                        ...(automatic && !publisher.meta.published
                          ? { date: "" }
                          : {}),
                      }))
                    }
                  />
                )}
                <p className="fine">
                  {kind === "stories"
                    ? "没有拍摄日期时保持空白。新故事中同一日拍摄的照片成功上传后可自动填入；追加照片不会覆盖已有或手工日期。"
                    : b.dateMode === "auto"
                      ? "尚未发布时日期留空，第一次发布采用北京时间日历日期；后续更新保留原日期。"
                      : "手动日期不会被发布或追加内容覆盖。"}
                </p>
              </div>
              {kind === "stories" ? (
                <>
                  <PhotoWorkbench
                    key={`photos-${editorEpoch}`}
                    value={b}
                    onChange={setB}
                    onBlockedChange={setMediaUploading}
                    isNew={item.id === "new"}
                  />
                  <StoryLocationFields
                    key={`location-${editorEpoch}`}
                    value={b}
                    onChange={setB}
                  />
                </>
              ) : (
                <>
                  <label>
                    上传封面
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      disabled={uploading}
                      onChange={upload}
                    />
                  </label>
                  {uploading && <p>正在上传…</p>}
                  {b.cover && (
                    <div className="uploaded-preview">
                      <img src={b.cover} alt="封面" />
                      <button type="button" onClick={() => set("cover", "")}>
                        移除封面
                      </button>
                    </div>
                  )}
                </>
              )}
              {kind === "projects" && (
                <ProjectAttachments
                  key={`attachments-${editorEpoch}`}
                  value={b}
                  onChange={setB}
                  onBlockedChange={setMediaUploading}
                />
              )}
            </>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {kind !== "surveys" && publisher.error && (
          <p className="error" role="alert">
            {publisher.error}
          </p>
        )}
        {kind !== "surveys" && (
          <div className="publishing-panel">
            <div className="publishing-status" role="status" aria-live="polite">
              <strong>
                {publisher.saving
                  ? "正在保存草稿…"
                  : publisher.dirty
                    ? "有尚未保存的修改"
                    : publisher.message ||
                      (publisher.meta.draft
                        ? "草稿已保存"
                        : "开始写作后自动保存")}
              </strong>
              <span>
                {publisher.meta.published
                  ? "线上保留已发布版本，点击「更新发布」后才会替换。"
                  : "草稿仅自己可见，发布后会出现在网站。"}
              </span>
              {(uploading || inlineUploading || mediaUploading) && (
                <span>
                  请完成照片、正文图片和附件上传；待上传或失败的文件须上传、重试或移除。
                </span>
              )}
            </div>
            <div className="publishing-actions">
              <button
                type="button"
                disabled={
                  !!publisher.action ||
                  uploading ||
                  inlineUploading ||
                  mediaUploading ||
                  publisher.saving ||
                  publisher.conflict
                }
                onClick={() => publisher.save(true).catch(() => {})}
              >
                <FloppyDisk />
                保存草稿
              </button>
              <button
                type="button"
                onClick={() => setPreview(!preview)}
                aria-expanded={preview}
              >
                <Eye />
                {preview ? "收起预览" : "预览文章"}
              </button>
              {publisher.meta.published && (
                <button
                  type="button"
                  disabled={
                    !!publisher.action ||
                    uploading ||
                    inlineUploading ||
                    mediaUploading ||
                    publisher.conflict
                  }
                  onClick={publisher.unpublish}
                >
                  撤下文章
                </button>
              )}
              <button
                className="button"
                disabled={
                  !!publisher.action ||
                  uploading ||
                  inlineUploading ||
                  mediaUploading ||
                  publisher.conflict
                }
              >
                {publisher.action
                  ? "正在处理…"
                  : publisher.meta.published
                    ? "更新发布"
                    : "发布文章"}
              </button>
            </div>
            {publisher.meta.published && (
              <a
                className="text-link"
                href={`/?${kind === "posts" ? "post" : kind === "stories" ? "story" : "project"}=${encodeURIComponent(publisher.meta.id)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看已发布文章 <ArrowUpRight />
              </a>
            )}
          </div>
        )}
        {kind !== "surveys" && preview && (
          <section className="article-preview" aria-label="文章预览">
            <div className="preview-toolbar">
              <strong>草稿预览</strong>
              <div className="segmented">
                <button
                  type="button"
                  className={previewSize === "desktop" ? "selected" : ""}
                  onClick={() => setPreviewSize("desktop")}
                >
                  电脑
                </button>
                <button
                  type="button"
                  className={previewSize === "phone" ? "selected" : ""}
                  onClick={() => setPreviewSize("phone")}
                >
                  手机
                </button>
              </div>
            </div>
            <div
              className={`article-preview-frame article-preview-${previewSize}`}
            >
              <ArticleContent
                item={publicContent(b, kind)}
                kind={kind}
                preview
              />
            </div>
          </section>
        )}
        {kind === "surveys" && (
          <fieldset
            className="editor-fields editor-save"
            disabled={surveySaving || reloading}
          >
            <Toggle
              label="发布到网站（取消则保存为草稿）"
              value={b.published}
              onChange={(v) => set("published", v)}
            />
            <button
              className="button"
              disabled={busy || uploading || surveySaving || surveyConflict}
            >
              <FloppyDisk />
              {surveySaving ? "正在保存…" : "保存"}
            </button>
          </fieldset>
        )}
      </form>
      {kind === "surveys" && preview && (
        <Survey
          key={JSON.stringify(b)}
          preview={normalizeSurveyDefinition(b)}
        />
      )}
    </>
  );
}
function Messages({ state, attempt }) {
  const [filter, setFilter] = useState("all"),
    [replies, setReplies] = useState({});
  const rows = state.messages.filter(
    (m) =>
      filter === "all" ||
      (filter === "waiting" && !m.reply) ||
      (filter === "private" && !m.public) ||
      (filter === "hidden" && m.hidden),
  );
  return (
    <>
      <div className="segmented">
        {[
          ["all", "全部"],
          ["waiting", "待回复"],
          ["private", "私密"],
          ["hidden", "已隐藏"],
        ].map(([k, l]) => (
          <button
            key={k}
            className={filter === k ? "selected" : ""}
            onClick={() => setFilter(k)}
          >
            {l}
          </button>
        ))}
      </div>
      {state.reports.length > 0 && (
        <section className="report-list">
          <h2>待处理举报 · {state.reports.length}</h2>
          {state.reports.map((r) => (
            <div key={r.id}>
              <p>
                {state.messages.find((m) => m.id === r.messageId)?.question ||
                  "问题已删除"}
                <br />
                <small>{r.reason}</small>
              </p>
              <button
                onClick={() =>
                  attempt(
                    () => api("/admin/reports/" + r.id, { method: "DELETE" }),
                    "已处理举报",
                  )
                }
              >
                标记已处理
              </button>
            </div>
          ))}
        </section>
      )}
      {rows.length ? (
        rows.map((m) => (
          <article className="admin-message" key={m.id}>
            <div className="message-meta">
              <span>
                {m.anonymous ? "匿名" : m.name} · {m.public ? "公开" : "私密"}
                {m.hidden ? " · 已隐藏" : ""}
              </span>
              <span>{date(m.createdAt)}</span>
            </div>
            <p className="question-text">{m.question}</p>
            {m.contact && <p className="fine">通知至：{m.contact.value}</p>}
            <textarea
              rows={3}
              aria-label="回复"
              placeholder="写下你的回复…"
              value={replies[m.id] ?? m.reply}
              onChange={(e) =>
                setReplies({ ...replies, [m.id]: e.target.value })
              }
            />
            <div className="row-actions">
              <button
                className="button"
                onClick={() =>
                  attempt(
                    () =>
                      api("/admin/messages/" + m.id, {
                        method: "PUT",
                        body: { reply: replies[m.id] ?? m.reply },
                      }),
                    "回复已保存；有联系方式的问答已加入通知队列",
                  )
                }
              >
                保存回复
              </button>
              <button
                onClick={() =>
                  attempt(() =>
                    api("/admin/messages/" + m.id, {
                      method: "PUT",
                      body: { hidden: !m.hidden },
                    }),
                  )
                }
              >
                {m.hidden ? "恢复展示" : "隐藏"}
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (confirm("永久删除这条问答？"))
                    attempt(
                      () =>
                        api("/admin/messages/" + m.id, { method: "DELETE" }),
                      "已删除",
                    );
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))
      ) : (
        <div className="empty">
          <h3>这里暂时没有问答。</h3>
        </div>
      )}
    </>
  );
}
function Results({ survey, close }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("all"),
    [loading, setLoading] = useState(true),
    [updatedAt, setUpdatedAt] = useState(null);
  const request = useRef(0);
  async function refresh() {
    const token = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await api("/admin/surveys/" + survey.id + "/results");
      if (token !== request.current) return;
      setData(result);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (token === request.current) setError(cause.message);
    } finally {
      if (token === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
    return () => {
      request.current++;
    };
  }, [survey.id]);
  const allRows = data?.rows || [];
  const rows = allRows.filter(
    (row) =>
      filter === "all" ||
      (filter === "terminated"
        ? row.completion === "terminated"
        : row.completion !== "terminated"),
  );
  const counts = surveyCompletionCounts(rows);
  const allCounts = surveyCompletionCounts(allRows);
  const summary = summarizeSurvey(survey, rows);
  const filterLabel = {
    all: "全部答卷",
    completed: "完整完成",
    terminated: "提前结束",
  }[filter];
  const exportFilter = filter === "all" ? "" : `&completion=${filter}`;
  const typeNames = {
    single: "单选分布",
    multiple: "多选分布",
    rank: "排序分布",
    multirank: "多选排序",
    matrix: "矩阵量表",
    text: "文字回答",
  };
  const percent = (value, denominator) =>
    denominator
      ? `${((value / denominator) * 100).toFixed(1).replace(/\.0$/, "")}%`
      : "—";
  return (
    <section className="survey-dashboard" aria-label="问卷统计">
      <button className="back" onClick={close}>
        <ArrowLeft /> 返回问卷
      </button>
      <header className="survey-dashboard-heading">
        <div>
          <span className="eyebrow">RESPONSES / 回答的轮廓</span>
          <h2>{survey.title}</h2>
          <p>从整体分布到每一份回答，查看这份问卷的真实提交。</p>
        </div>
        <div className="survey-dashboard-index" aria-hidden="true">
          <span>QUESTION ATLAS</span>
          <strong>{String(survey.questions.length).padStart(2, "0")}</strong>
          <small>QUESTIONS / 题目</small>
        </div>
      </header>
      <div className="survey-results-controls">
        <div
          className="survey-results-filters"
          role="group"
          aria-label="按答卷完成状态筛选"
        >
          {[
            ["all", "全部", allRows.length],
            ["completed", "完整完成", allCounts.completed],
            ["terminated", "提前结束", allCounts.terminated],
          ].map(([value, label, count]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
              <span>{data ? count : "—"}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="survey-results-refresh"
          onClick={refresh}
          disabled={loading}
        >
          {loading ? "正在读取…" : "↻ 刷新数据"}
        </button>
      </div>
      <div className="survey-data-provenance">
        <p>当前筛选：{filterLabel} · 图表、逐份记录和导出使用同一范围</p>
        <span>
          {updatedAt
            ? `更新于 ${updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}`
            : "读取服务器记录"}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
          {data ? "；下方保留上次成功读取的数据。" : ""}
        </p>
      )}
      {!data && loading && <p role="status">正在读取答卷…</p>}
      {data && (
        <>
          <div
            className="survey-overview-stats"
            aria-label="当前筛选数据概要"
            aria-live="polite"
          >
            {[
              ["当前答卷", rows.length, "SUBMISSIONS"],
              ["完整完成", counts.completed, "COMPLETED"],
              ["提前结束", counts.terminated, "ENDED EARLY"],
              ["问卷题目", survey.questions.length, "QUESTIONS"],
            ].map(([label, value, en]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{en}</small>
              </div>
            ))}
          </div>
          <p className="survey-count-note">
            数量按答卷计算，允许重复填写，不代表去重人数。提前结束的答卷保留结束前的有效回答。
          </p>
          {!rows.length ? (
            <div className="survey-results-empty">
              <span className="eyebrow">NO RESPONSES IN THIS VIEW</span>
              <h3>这个范围还没有答卷。</h3>
              <p>
                {allRows.length
                  ? "切换到其他完成状态，查看已有回答。"
                  : "有人提交后，选项分布与矩阵统计会显示在这里。"}
              </p>
            </div>
          ) : (
            <div className="survey-charts-grid" aria-busy={loading}>
              {summary.map((q, index) => (
                <article
                  className={`survey-chart-card ${q.matrix ? "survey-chart-wide" : ""}`}
                  key={q.id}
                >
                  <div className="survey-chart-topline">
                    <span>
                      {String(index + 1).padStart(2, "0")} / DISTRIBUTION
                    </span>
                    <span>{typeNames[q.type] || "回答分布"}</span>
                  </div>
                  <h3>{q.title}</h3>
                  <p className="survey-chart-deck">
                    {q.answered} 份有回答 / 当前 {rows.length} 份答卷
                  </p>
                  {q.counts && (
                    <div
                      className="survey-bars"
                      aria-label={`${q.title}选项分布`}
                    >
                      {Object.entries(q.counts).map(([option, count]) => (
                        <div className="survey-bar-row" key={option}>
                          <div className="survey-bar-label">
                            <span>{option}</span>
                            <span>
                              <b>{count}</b> 份{" "}
                              <em>{percent(count, q.answered)}</em>
                            </span>
                          </div>
                          <div className="survey-bar-track" aria-hidden="true">
                            <i
                              style={{
                                width: `${q.answered ? (count / q.answered) * 100 : 0}%`,
                              }}
                            />
                          </div>
                          {q.rank && (
                            <small>
                              已选该项答卷中的平均名次：{q.rank[option] ?? "—"}
                            </small>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {q.matrix && (
                    <div className="survey-matrix-results">
                      <div className="survey-heatmap-legend">
                        <i />
                        <span>颜色越深，该行选择此项的比例越高</span>
                      </div>
                      <div
                        className="survey-heatmap-scroll"
                        role="region"
                        aria-label={`${q.title}矩阵分布表，可横向滚动`}
                        tabIndex={0}
                      >
                        <table className="survey-heatmap">
                          <caption>
                            每格显示答卷数与占该行有效回答的比例
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">陈述</th>
                              {Object.keys(q.matrix[0]?.counts || {}).map(
                                (option) => (
                                  <th scope="col" key={option}>
                                    {option}
                                  </th>
                                ),
                              )}
                              <th scope="col">该行回答</th>
                            </tr>
                          </thead>
                          <tbody>
                            {q.matrix.map((matrixRow) => (
                              <tr key={matrixRow.id}>
                                <th scope="row">{matrixRow.title}</th>
                                {Object.entries(matrixRow.counts).map(
                                  ([option, count]) => (
                                    <td
                                      key={option}
                                      style={{
                                        background: `rgba(196, 144, 83, ${count && matrixRow.answered ? 0.1 + (count / matrixRow.answered) * 0.58 : 0.025})`,
                                      }}
                                    >
                                      <strong>{count}</strong>
                                      <small>
                                        {percent(count, matrixRow.answered)}
                                      </small>
                                    </td>
                                  ),
                                )}
                                <td className="survey-heatmap-total">
                                  {matrixRow.answered} 份
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {q.type === "text" && (
                    <div className="survey-text-sample">
                      {rows
                        .filter(
                          (row) =>
                            typeof row.answers?.[q.id] === "string" &&
                            row.answers[q.id],
                        )
                        .slice(0, 3)
                        .map((row) => (
                          <blockquote key={row.id}>
                            {row.answers[q.id]}
                          </blockquote>
                        ))}
                      <p>
                        {q.answered
                          ? "展示前 3 条回答；完整内容可在下方逐份查看或导出。"
                          : "这道题暂无文字回答。"}
                      </p>
                    </div>
                  )}
                  <details className="survey-chart-method">
                    <summary>
                      如何阅读这张图 <span>＋</span>
                    </summary>
                    <p>
                      {q.matrix
                        ? "每一行单独计算：该选项的答卷数 ÷ 该行有效回答数。未回答该行的答卷不进入分母；只展示分布，不将文字选项换算为心理分数。"
                        : q.type === "text"
                          ? "文字回答保留原文，不自动进行情绪或人格判断。"
                          : `每个选项的比例 = 选择该项的答卷数 ÷ 本题有回答的答卷数（${q.answered} 份）。${["multiple", "multirank", "rank"].includes(q.type) ? "同一份答卷可包含多个选项，因此比例之和可能超过 100%。" : ""}${q.rank ? "平均名次只计算选择该项的答卷，数值越小代表排序越靠前。" : ""}`}{" "}
                      统计按当前题目与选项展示；修改前的原始题目和回答保留在逐份记录中。
                    </p>
                  </details>
                </article>
              ))}
            </div>
          )}
          <div className="survey-submissions-heading">
            <div>
              <span className="eyebrow">RESPONSE RECORDS / 原始回答</span>
              <h3>
                逐份答卷 <span>{rows.length}</span>
              </h3>
            </div>
            <div className="row-actions">
              <a
                className="button"
                href={`/api/admin/surveys/${survey.id}/export?format=xlsx${exportFilter}`}
              >
                下载 Excel
              </a>
              <a
                className="quiet"
                href={`/api/admin/surveys/${survey.id}/export?format=csv${exportFilter}`}
              >
                下载 CSV
              </a>
            </div>
          </div>
          {rows.map((r, i) => (
            <details className="submission" key={r.id}>
              <summary>
                <span>
                  答卷 {rows.length - i} ·{" "}
                  {new Date(r.createdAt).toLocaleString("zh-CN")}
                </span>
                <span
                  className={`survey-completion-badge ${r.completion === "terminated" ? "is-terminated" : ""}`}
                >
                  {r.completion === "terminated" ? "提前结束" : "完整完成"}
                </span>
              </summary>
              {r.completion === "terminated" && (
                <p className="survey-termination-note">
                  结束于「{r.termination?.questionTitle || "未记录题目"}」
                  {r.termination?.option
                    ? ` · 选项：${r.termination.option}`
                    : ""}
                </p>
              )}
              {(r.questions || survey.questions).map((q) => (
                <div className="survey-submission-answer" key={q.id}>
                  <strong>{q.title}</strong>
                  {q.type === "matrix" ? (
                    <dl className="survey-matrix-answer">
                      {(q.rows || []).map((row) => (
                        <div key={row.id}>
                          <dt>{row.title}</dt>
                          <dd>
                            {r.answers?.[q.id]?.[row.id] || "未作答 / 已跳过"}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p>
                      {Array.isArray(r.answers?.[q.id])
                        ? r.answers[q.id].join(
                            q.type.includes("rank") ? " → " : "、",
                          )
                        : typeof r.answers?.[q.id] === "string"
                          ? r.answers[q.id]
                          : "未作答 / 已跳过"}
                      {r.answers?.[q.id + "__other"] &&
                        " · 其他：" + r.answers[q.id + "__other"]}
                    </p>
                  )}
                </div>
              ))}
            </details>
          ))}
        </>
      )}
    </section>
  );
}
export function Notifications({ state, attempt, busy }) {
  const [n, setN] = useState(state.notifications),
    [mapping, setMapping] = useState(
      JSON.stringify(
        state.notifications.templateParams || {
          reply: "{{reply}}",
          link: "{{link}}",
        },
        null,
        2,
      ),
    ),
    [mappingError, setMappingError] = useState(""),
    [password, setPassword] = useState({ current: "", next: "" });
  const set = (k, v) => setN({ ...n, [k]: v });
  const status = {
    pending: "等待发送",
    unconfigured: "尚未配置",
    failed: "发送失败",
    sent: "已发送",
    sending: "正在发送",
    cancelled: "已取消",
  };
  return (
    <>
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const params = JSON.parse(mapping);
            if (!params || Array.isArray(params) || typeof params !== "object")
              throw Error();
            setMappingError("");
            attempt(() =>
              api("/admin/notifications", {
                method: "PUT",
                body: { ...n, templateParams: params },
              }),
            );
          } catch {
            setMappingError("短信模板参数需为有效JSON对象");
          }
        }}
      >
        <p className="fine">
          阿里云邮件推送与短信服务。凭证只保存在服务器数据目录中，不发送给访客。空白密钥表示保留现有密钥。
        </p>
        <Field
          label="正式网站地址"
          type="url"
          value={n.siteUrl}
          onChange={(v) => set("siteUrl", v)}
          placeholder="https://你的域名"
        />
        <div className="field-grid">
          <Field
            label="AccessKey ID"
            value={n.accessKeyId}
            onChange={(v) => set("accessKeyId", v)}
            autoComplete="off"
          />
          <Field
            label={"AccessKey Secret" + (n.hasSecret ? "（已配置）" : "")}
            type="password"
            value={n.accessKeySecret}
            onChange={(v) => set("accessKeySecret", v)}
            autoComplete="new-password"
          />
        </div>
        <h2>邮件</h2>
        <Field
          label="已验证的发信地址 AccountName"
          value={n.accountName}
          onChange={(v) => set("accountName", v)}
        />
        <Field
          label="邮件服务端点"
          value={n.mailEndpoint}
          onChange={(v) => set("mailEndpoint", v)}
          placeholder="https://dm.aliyuncs.com"
        />
        <h2>短信</h2>
        <div className="field-grid">
          <Field
            label="审核通过的短信签名"
            value={n.signName}
            onChange={(v) => set("signName", v)}
          />
          <Field
            label="审核通过的短信模板编号"
            value={n.templateCode}
            onChange={(v) => set("templateCode", v)}
          />
        </div>
        <Field
          label="模板参数映射"
          type="textarea"
          rows={5}
          value={mapping}
          onChange={setMapping}
        />
        <p className="fine">
          键名需与阿里云审核模板的变量一致。值中 {"{{reply}}"} 替换为回答，
          {"{{link}}"} 替换为查看地址；实际可发送内容依模板审核要求决定。
        </p>
        {mappingError && <p className="error">{mappingError}</p>}
        <button className="button" disabled={busy}>
          <FloppyDisk /> 保存通知配置
        </button>
      </form>
      <section className="subsection">
        <h2>发送记录</h2>
        <p className="fine">
          尚未配置或发送失败的任务不会标记为成功，配置完成后可重试。
        </p>
        <button
          className="quiet"
          onClick={() => attempt(async () => {}, "发送状态已刷新")}
        >
          刷新发送状态
        </button>
        {state.outbox.length ? (
          state.outbox.map((j) => (
            <div className="outbox-row" key={j.id}>
              <div>
                <strong>{j.contact?.value || "联系方式已清除"}</strong>
                <p>
                  {status[j.status]} · {date(j.createdAt)}
                </p>
                {j.error && <small>{j.error}</small>}
              </div>
              {["pending", "failed", "unconfigured"].includes(j.status) && (
                <button
                  onClick={() =>
                    attempt(
                      () =>
                        api("/admin/outbox/" + j.id + "/retry", {
                          method: "POST",
                        }),
                      "任务已重新排队",
                    )
                  }
                >
                  重试
                </button>
              )}
            </div>
          ))
        ) : (
          <p>尚无发送记录。</p>
        )}
      </section>
      <section className="subsection">
        <h2>修改管理密码</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            attempt(
              () => api("/admin/password", { method: "PUT", body: password }),
              "密码已修改，请重新登录",
            );
          }}
        >
          <Field
            label="当前密码"
            type="password"
            value={password.current}
            onChange={(v) => setPassword({ ...password, current: v })}
            required
          />
          <Field
            label="新密码（至少12位）"
            type="password"
            minLength={12}
            value={password.next}
            onChange={(v) => setPassword({ ...password, next: v })}
            required
          />
          <button className="quiet">修改密码</button>
        </form>
      </section>
    </>
  );
}
