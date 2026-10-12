import React, { useEffect, useState, lazy, Suspense } from "react";
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
import Survey from "./survey";
const World = lazy(() => import("./world"));
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
  title: "",
  body: "",
  published: false,
  cover: "",
  link: "",
  category: "",
  status: "",
  excerpt: "",
  date: new Date().toISOString().slice(0, 10),
  location: "",
  city: "",
  lat: 23.1291,
  lng: 113.2644,
  photos: [],
  description: "",
  questions: kind === "surveys" ? [newQuestion()] : [],
  closed: false,
  publicResults: false,
  successMessage: "谢谢，你的回答已被保存。",
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
});
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
function Toggle({ label, value, onChange }) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
export default function Admin() {
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
        <a className="wordmark" href="/">
          林珈诚<span>YOUR PERSONAL SPACE</span>
        </a>
        <span className="eyebrow">管理空间</span>
        <nav>
          {Object.entries(labels).map(([k, v]) => (
            <button
              key={k}
              className={tab === k ? "active" : ""}
              onClick={() => {
                setTab(k);
                setEditor(null);
                setError("");
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
          onClick={() =>
            attempt(() => api("/logout", { method: "POST" }), "已退出")
          }
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
            save={(b) =>
              attempt(() => api("/admin/profile", { method: "PUT", body: b }))
            }
          />
        )}
        {["projects", "posts", "stories", "surveys"].includes(tab) &&
          (editor ? (
            <ContentEditor
              key={tab + editor.id}
              kind={tab}
              item={editor}
              busy={busy}
              close={() => setEditor(null)}
              save={async (b) => {
                if (
                  await attempt(() =>
                    api("/admin/" + tab + "/" + b.id, {
                      method: "PUT",
                      body: b,
                    }),
                  )
                )
                  setEditor(null);
              }}
            />
          ) : (
            <div className="admin-list">
              {state[tab].length ? (
                state[tab].map((x) => (
                  <div className="admin-list-row" key={x.id}>
                    <div>
                      <span className="eyebrow">
                        {x.published ? "已发布" : "草稿"}
                        {x.closed ? " · 已关闭" : ""}
                      </span>
                      <h3>{x.title}</h3>
                      <p>{date(x.updatedAt || x.createdAt)}</p>
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
function Profile({ data, save, busy }) {
  const [b, setB] = useState(data),
    [uploading, setUploading] = useState(false),
    [err, setErr] = useState("");
  const set = (k, v) => setB({ ...b, [k]: v });
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
        save(b);
      }}
    >
      <div className="field-grid">
        <Field
          label="名字"
          value={b.name}
          onChange={(v) => set("name", v)}
          required
        />
        <Field
          label="公开邮箱"
          value={b.email}
          type="email"
          onChange={(v) => set("email", v)}
        />
        <Field
          label="公开手机号"
          value={b.phone}
          onChange={(v) => set("phone", v)}
        />
        <Field
          label="公开微信号"
          value={b.wechat}
          onChange={(v) => set("wechat", v)}
        />
        <Field
          label="GitHub / 公开主页链接"
          value={b.github}
          type="url"
          onChange={(v) => set("github", v)}
        />
      </div>
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
                b.interests.map((y, j) => (j === i ? { ...y, status: v } : y)),
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
      <button className="button" disabled={busy || uploading}>
        <FloppyDisk /> 保存资料
      </button>
    </form>
  );
}
function ContentEditor({ kind, item, save, close, busy }) {
  const [b, setB] = useState(item),
    [preview, setPreview] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState(""),
    [places, setPlaces] = useState([]),
    [query, setQuery] = useState(""),
    [gpsFound, setGpsFound] = useState(false);
  const set = (k, v) => setB((prev) => ({ ...prev, [k]: v }));
  const updateQ = (i, key, v) =>
    setB((prev) => ({
      ...prev,
      questions: prev.questions.map((q, j) =>
        i === j ? { ...q, [key]: v } : q,
      ),
    }));
  useEffect(() => {
    if (kind !== "stories" || !gpsFound) return;
    let active = true;
    setB((prev) => ({ ...prev, confirmLocation: false }));
    const t = setTimeout(() => {
      api(`/admin/reverse?lat=${b.lat}&lng=${b.lng}`)
        .then((d) => {
          if (active)
            setB((prev) => ({
              ...prev,
              city: d.city,
              cityLat: d.cityLat,
              cityLng: d.cityLng,
              location: prev.location || d.location,
            }));
        })
        .catch(() => {
          if (active) setError("自动识别城市暂不可用，请手动填写附近城市。");
        });
    }, 1100);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [b.lat, b.lng, gpsFound]);
  async function upload(e) {
    const selected = [...e.target.files];
    if (!selected.length) return;
    setUploading(true);
    setError("");
    try {
      if (kind === "stories") {
        const exifr = await import("exifr");
        for (const f of selected) {
          const gps = await exifr.gps(f).catch(() => null);
          if (gps) {
            setB((prev) => ({
              ...prev,
              lat: gps.latitude,
              lng: gps.longitude,
            }));
            setGpsFound(true);
            break;
          }
        }
      }
      const form = new FormData();
      selected.forEach((f) => form.append("files", f));
      const r = await api("/admin/upload", { method: "POST", body: form });
      if (!r.files.length) throw Error("请上传 JPG、PNG、WebP、GIF 或 PDF");
      if (kind === "stories")
        setB((prev) => ({
          ...prev,
          photos: [...prev.photos, ...r.files.map((f) => f.url)],
        }));
      else set("cover", r.files[0].url);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }
  async function search(e) {
    e.preventDefault();
    try {
      setPlaces(await api("/geocode?q=" + encodeURIComponent(query)));
    } catch (e) {
      setError(e.message);
    }
  }
  function pick(c) {
    setB((prev) => ({ ...prev, lat: Number(c.lat), lng: Number(c.lng) }));
    setGpsFound(true);
  }
  if (item.showResults) return <Results survey={item} close={close} />;
  return (
    <>
      <button className="back" onClick={close}>
        <ArrowLeft /> 返回列表
      </button>
      <form
        className="editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (kind === "stories" && b.published && !b.confirmLocation) {
            setError("请确认照片的精确位置后再发布");
            return;
          }
          save(
            kind === "surveys"
              ? {
                  ...b,
                  startsAt: b.startsAt
                    ? new Date(b.startsAt).toISOString()
                    : "",
                  endsAt: b.endsAt ? new Date(b.endsAt).toISOString() : "",
                }
              : b,
          );
        }}
      >
        <Field
          label="标题"
          value={b.title}
          onChange={(v) => set("title", v)}
          required
        />
        {kind === "surveys" ? (
          <>
            <Field
              label="问卷说明"
              type="textarea"
              rows={3}
              value={b.description}
              onChange={(v) => set("description", v)}
            />
            <div className="field-grid">
              <Field
                label="开始时间（可留空）"
                type="datetime-local"
                value={localTime(b.startsAt)}
                onChange={(v) => set("startsAt", v)}
              />
              <Field
                label="截止时间（可留空）"
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
              value={b.successMessage}
              onChange={(v) => set("successMessage", v)}
            />
            <h2>题目编辑</h2>
            <p className="fine">
              按顺序展示；同名章节连续分组。条件题只在指定的前置答案出现时显示，其他答案自动跳过。
            </p>
            {b.questions.map((q, i) => (
              <section className="question-editor" key={q.id}>
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
                    value={q.title}
                    onChange={(v) => updateQ(i, "title", v)}
                    required
                  />
                  <label>
                    题型
                    <select
                      value={q.type}
                      onChange={(e) => updateQ(i, "type", e.target.value)}
                    >
                      {[
                        ["single", "单选"],
                        ["multiple", "多选"],
                        ["rank", "全部排序"],
                        ["multirank", "多选后排序"],
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
                    label="选项（每行一个）"
                    type="textarea"
                    rows={4}
                    value={q.options.join("\n")}
                    onChange={(v) => updateQ(i, "options", v.split("\n"))}
                  />
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
                        type="number"
                        min="0"
                        value={q.min}
                        onChange={(v) => updateQ(i, "min", v)}
                      />
                      <Field
                        label="最多选择（0为不限）"
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
                    value={q.allowOther}
                    onChange={(v) => updateQ(i, "allowOther", v)}
                  />
                )}
                <details>
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
                      {b.questions
                        .slice(0, i)
                        .filter((x) => x.type !== "text")
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
                        {(
                          b.questions.find(
                            (x) => x.id === q.condition.questionId,
                          )?.options || []
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
              onClick={() => set("questions", [...b.questions, newQuestion()])}
            >
              <Plus /> 添加题目
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => setPreview(!preview)}
            >
              <Eye />
              {preview ? "关闭预览" : "预览问卷"}
            </button>
            {preview && <Survey key={JSON.stringify(b)} preview={b} />}
          </>
        ) : (
          <>
            <Field
              label={kind === "stories" ? "照片故事" : "正文（空行分段）"}
              type="textarea"
              rows={12}
              value={b.body}
              onChange={(v) => set("body", v)}
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
            <label>
              {kind === "stories"
                ? "上传照片（最多20张，每张15MB）"
                : "上传封面"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple={kind === "stories"}
                disabled={uploading}
                onChange={upload}
              />
            </label>
            {uploading && <p>正在上传…</p>}
            {kind !== "stories" && b.cover && (
              <div className="uploaded-preview">
                <img src={b.cover} alt="封面" />
                <button type="button" onClick={() => set("cover", "")}>
                  移除封面
                </button>
              </div>
            )}
            {kind === "stories" && (
              <>
                <div className="upload-gallery">
                  {b.photos.map((p, i) => (
                    <div key={p}>
                      <img src={p} alt={"照片" + (i + 1)} />
                      <button
                        type="button"
                        aria-label="移除照片"
                        onClick={() =>
                          set(
                            "photos",
                            b.photos.filter((_, j) => j !== i),
                          )
                        }
                      >
                        <X />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="field-grid">
                  <Field
                    label="拍摄 / 旅行日期"
                    type="date"
                    value={b.date}
                    onChange={(v) => set("date", v)}
                  />
                  <Field
                    label="地点名称"
                    value={b.location}
                    onChange={(v) => set("location", v)}
                  />
                  <Field
                    label="附近城市（远景聚合用）"
                    value={b.city}
                    onChange={(v) => set("city", v)}
                  />
                </div>
                <div className="place-search">
                  <Field
                    label="搜索地址或景点"
                    value={query}
                    onChange={setQuery}
                  />
                  <button type="button" onClick={search}>
                    搜索地点
                  </button>
                </div>
                {places.map((p, i) => (
                  <button
                    className="place-result"
                    type="button"
                    key={i}
                    onClick={() => {
                      setB((prev) => ({
                        ...prev,
                        lat: Number(p.lat),
                        lng: Number(p.lon),
                        location: p.display_name,
                        city:
                          p.address?.city ||
                          p.address?.town ||
                          p.address?.county ||
                          p.name ||
                          "",
                        cityLat: Number(p.lat),
                        cityLng: Number(p.lon),
                        confirmLocation: false,
                      }));
                      setPlaces([]);
                      setGpsFound(true);
                    }}
                  >
                    {p.display_name}
                  </button>
                ))}
                <div className="field-grid">
                  <Field
                    label="精确纬度"
                    type="number"
                    step="any"
                    min="-90"
                    max="90"
                    value={b.lat}
                    onChange={(v) => set("lat", v)}
                  />
                  <Field
                    label="精确经度"
                    type="number"
                    step="any"
                    min="-180"
                    max="180"
                    value={b.lng}
                    onChange={(v) => set("lng", v)}
                  />
                </div>
                {gpsFound && (
                  <p className="fine">
                    已读取或选择坐标，请确认地点名称和位置。
                  </p>
                )}
                <Suspense fallback={<p>正在打开地图…</p>}>
                  <World
                    compact
                    pick={{ lat: b.lat, lng: b.lng }}
                    onPick={pick}
                  />
                </Suspense>
                <Toggle
                  label="我已确认这个精确位置可以公开"
                  value={b.confirmLocation}
                  onChange={(v) => set("confirmLocation", v)}
                />
              </>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="editor-save">
          <Toggle
            label="发布到网站（取消则保存为草稿）"
            value={b.published}
            onChange={(v) => set("published", v)}
          />
          <button className="button" disabled={busy || uploading}>
            <FloppyDisk />
            {busy ? "正在保存…" : "保存"}
          </button>
        </div>
      </form>
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
    [error, setError] = useState("");
  useEffect(() => {
    api("/admin/surveys/" + survey.id + "/results")
      .then(setData)
      .catch((e) => setError(e.message));
  }, [survey.id]);
  return (
    <>
      <button className="back" onClick={close}>
        <ArrowLeft /> 返回问卷
      </button>
      <h2>{survey.title}</h2>
      <div className="row-actions">
        <a
          className="button"
          href={"/api/admin/surveys/" + survey.id + "/export?format=xlsx"}
        >
          下载 Excel
        </a>
        <a
          className="quiet"
          href={"/api/admin/surveys/" + survey.id + "/export?format=csv"}
        >
          下载 CSV
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <p>共 {data.rows.length} 份答卷 · 允许重复填写</p>
          {data.summary.map((q) => (
            <div className="result-block" key={q.id}>
              <h3>{q.title}</h3>
              <span className="fine">{q.answered} 人作答</span>
              {q.counts &&
                Object.entries(q.counts).map(([o, n]) => (
                  <div className="stat-row" key={o}>
                    <span>{o}</span>
                    <div>
                      <i
                        style={{
                          width:
                            (q.answered ? (n / q.answered) * 100 : 0) + "%",
                        }}
                      />
                    </div>
                    <b>{n}</b>
                    {q.rank && <small>平均名次 {q.rank[o] ?? "—"}</small>}
                  </div>
                ))}
            </div>
          ))}
          <h2>逐份答卷</h2>
          {data.rows.map((r, i) => (
            <details className="submission" key={r.id}>
              <summary>
                答卷 {data.rows.length - i} ·{" "}
                {new Date(r.createdAt).toLocaleString("zh-CN")}
              </summary>
              {(r.questions || survey.questions).map((q) => (
                <div key={q.id}>
                  <strong>{q.title}</strong>
                  <p>
                    {Array.isArray(r.answers[q.id])
                      ? r.answers[q.id].join(" → ")
                      : r.answers[q.id] || "未作答 / 已跳过"}
                    {r.answers[q.id + "__other"] &&
                      " · 其他：" + r.answers[q.id + "__other"]}
                  </p>
                </div>
              ))}
            </details>
          ))}
        </>
      )}
    </>
  );
}
function Notifications({ state, attempt, busy }) {
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
                <strong>{j.contact.value}</strong>
                <p>
                  {status[j.status]} · {date(j.createdAt)}
                </p>
                {j.error && <small>{j.error}</small>}
              </div>
              {j.status !== "sent" && (
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
