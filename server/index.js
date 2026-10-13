import express from "express";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import {
  list,
  get,
  put,
  remove,
  setting,
  setSetting,
  transaction,
} from "./store.js";
import {
  validateSurvey,
  validateAnswers,
  surveyFlow,
  summarizeSurvey,
  surveyCompletionCounts,
} from "./validation.js";
import {
  notify,
  deliver,
  normalizeContact,
  normalizeSiteOrigin,
  cancelNotifications,
  retryNotification,
  recoverNotificationJobs,
} from "./notifications.js";
import {
  assertRevision,
  revisionOf,
  versionedSurvey,
  surveyExport,
} from "./versions.js";
import {
  submissionReceipt,
  replayReceipt,
  saveReceipt,
  eraseReceipts,
} from "./submissions.js";
import { registerMediaRoutes } from "./media.js";
import { startAtlas } from "./atlas-gateway.js";
import { normalizeProfile, publicProfile } from "./profile.js";
import {
  checkRevision,
  contentRevision,
  editableContent,
  publicContent,
  validatePublication,
} from "./content.js";
import { saveContentDraft, transitionContent } from "./admin-content.js";
const app = express();
const port = Number(process.env.PORT || 5193);
const atlas =
  process.env.ATLAS_ENABLED === "0" ||
  (process.env.TEST_MODE && process.env.ATLAS_ENABLED !== "1")
    ? null
    : await startAtlas();
if (process.env.TEST_MODE && atlas) {
  process.stdin.resume();
  process.stdin.once("end", () => {
    atlas.stop();
    process.exit(0);
  });
}
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const secretHash = (value, salt) => scryptSync(value, salt, 64).toString("hex");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  if (atlas?.live) res.set("X-Atlas-Live-Weather", "1");
  if (/^\/api(?:\/|$)/i.test(req.path)) res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    let origin;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      return res.status(400).json({ error: "Origin 格式无效" });
    }
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.host !== req.headers.host
    )
      return res.status(403).json({ error: "不允许跨站提交" });
  }
  next();
});
// Public personal assets win only when a real public file exists. Never serve
// the private database directory; /data belongs exclusively to the Atlas.
app.use(express.static(resolve("public"), { index: false, dotfiles: "deny" }));
if (atlas) app.use(atlas.middleware);
app.use(express.json({ limit: "2mb" }));
app.use("/api", (req, res, next) => {
  if (
    req.is("application/json") &&
    req.body !== undefined &&
    (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
  )
    return res.status(400).json({ error: "请求正文需要 JSON 对象" });
  req.body ||= {};
  next();
});
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
app.get("/api/health", (req, res) =>
  res.json({ application: "personal-universe", atlas: Boolean(atlas?.live) }),
);
const sessions = new Map();
const rates = new Map();
function limit(name, max, window) {
  return (req, res, next) => {
    const key = name + req.ip;
    const now = Date.now();
    let a = (rates.get(key) || []).filter((t) => now - t < window);
    if (a.length >= max)
      return res.status(429).json({ error: "操作频繁，请稍后再试" });
    a.push(now);
    rates.set(key, a);
    next();
  };
}
const publicMessage = (m) => ({
  id: m.id,
  name: m.anonymous ? "匿名" : m.name,
  question: m.question,
  reply: m.reply,
  createdAt: m.createdAt,
  repliedAt: m.repliedAt,
});
function auth(req, res, next) {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("space_session="))
    ?.slice(14);
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now())
    return res.status(401).json({ error: "请先登录后台" });
  next();
}
function establish(req, res) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + 12 * 3600000);
  res.cookie("space_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    maxAge: 12 * 3600000,
  });
  res.json({ ok: true });
}
app.get("/api/status", (req, res) =>
  res.json({ needsSetup: !setting("admin") }),
);
app.post("/api/setup", limit("setup", 5, 60000), (req, res) => {
  if (process.argv.includes("--production") && process.env.TEST_MODE !== "1")
    return res.status(403).json({
      error: "生产环境已关闭 HTTP 初始化，请在服务器运行本地初始化命令。",
    });
  if (setting("admin")) return res.status(409).json({ error: "管理员已设置" });
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
  )
    return res.status(403).json({ error: "首次设置请在服务器本地进行" });
  const { username, password } = req.body;
  if (
    typeof username !== "string" ||
    !username.trim() ||
    username.length > 80 ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 1024
  )
    return res.status(400).json({ error: "用户名不能为空，密码至少12位" });
  const salt = randomBytes(16).toString("hex");
  setSetting("admin", { username, salt, password: secretHash(password, salt) });
  establish(req, res);
});
app.post("/api/login", limit("login", 10, 60000), (req, res) => {
  const a = setting("admin");
  if (
    !a ||
    typeof req.body.password !== "string" ||
    req.body.username !== a.username ||
    !timingSafeEqual(
      Buffer.from(secretHash(req.body.password, a.salt), "hex"),
      Buffer.from(a.password, "hex"),
    )
  )
    return res.status(401).json({ error: "用户名或密码不正确" });
  establish(req, res);
});
app.post("/api/logout", (req, res) => {
  const t = req.headers.cookie?.match(/space_session=([^;]+)/)?.[1];
  sessions.delete(t);
  res.clearCookie("space_session");
  res.json({ ok: true });
});
app.get("/api/public", (req, res) =>
  res.json({
    profile: publicProfile(setting("profile")),
    projects: list("projects")
      .filter((x) => x.published)
      .map(publicContent),
    posts: list("posts")
      .filter((x) => x.published)
      .map(publicContent),
    stories: list("stories")
      .filter((x) => x.published)
      .map(publicContent),
    surveys: list("surveys")
      .filter((x) => x.published)
      .map(({ questions, ...s }) => ({
        ...s,
        questionCount: questions.length,
      })),
    messages: list("messages")
      .filter((x) => x.public && !x.hidden)
      .map(publicMessage),
  }),
);
app.post(
  "/api/questions",
  (req, res, next) => {
    try {
      req.receipt = submissionReceipt("questions", req.body);
      if (replayReceipt(req.receipt, res)) return;
      next();
    } catch (error) {
      next(error);
    }
  },
  limit("ask", 8, 60000),
  (req, res) => {
    const receipt = req.receipt;
    if (!setting("profile").acceptQuestions)
      return res.status(403).json({ error: "提问暂时关闭" });
    const b = req.body;
    if (
      typeof b.question !== "string" ||
      !b.question.trim() ||
      b.question.length > 5000
    )
      return res.status(400).json({ error: "问题需为1至5000字" });
    if (
      !b.anonymous &&
      (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80)
    )
      return res.status(400).json({ error: "请填写署名（最多80字）" });
    if (
      b.recovery !== undefined &&
      (typeof b.recovery !== "string" || b.recovery.length > 320)
    )
      return res
        .status(400)
        .json({ error: "联系方式或找回字符串需为文字，最多320字" });
    const input = (b.recovery || "").trim();
    const contact = normalizeContact(input);
    const phrase =
      contact || !input ? randomBytes(12).toString("base64url") : input;
    if (phrase && phrase.length < 8)
      return res.status(400).json({ error: "私密字符串请使用至少8个字符" });
    if (phrase && list("messages").some((m) => m.phraseHash === hash(phrase)))
      return res
        .status(409)
        .json({ error: "这个私密字符串已被使用，请换一个" });
    const m = {
      id: randomUUID(),
      token: randomBytes(32).toString("hex"),
      question: b.question.trim(),
      anonymous: !!b.anonymous,
      name: b.anonymous ? "" : b.name.trim(),
      public: !!b.public,
      hidden: false,
      contact,
      phraseHash: hash(phrase),
      reply: "",
      createdAt: new Date().toISOString(),
    };
    const response = {
      link: `/?answer=${m.token}`,
      recoveryPhrase: phrase,
      id: m.id,
    };
    transaction(() => {
      put("messages", m);
      saveReceipt(receipt, "messages", m.id, response);
    });
    res.status(201).json(response);
  },
);
app.get("/api/answers/:token", (req, res) => {
  const m = list("messages").find((x) => x.token === req.params.token);
  if (!m) return res.status(404).json({ error: "链接无效" });
  res.json(publicMessage(m));
});
app.post("/api/recover", limit("recover", 5, 60000), (req, res) => {
  if (
    typeof req.body.key !== "string" ||
    req.body.key.length > 320 ||
    !req.body.key.trim()
  )
    return res
      .status(400)
      .json({ error: "请填写找回字符串或联系方式，最多320字" });
  const key = req.body.key.trim();
  const contact = normalizeContact(key);
  if (contact) {
    for (const m of list("messages").filter(
      (x) => x.contact?.value === contact.value,
    ))
      notify(m, m.reply || "问题已收到，暂未回复。");
    void deliver();
    return res.json({
      sent: true,
      message: "若此联系方式有关联问答，查看入口将发送到该联系方式。",
    });
  }
  const m = list("messages").find(
    (x) => x.phraseHash && x.phraseHash === hash(key),
  );
  if (!m)
    return res.status(404).json({ error: "未找到对应问答，请检查私密字符串" });
  res.json({ link: `/?answer=${m.token}` });
});
app.post("/api/questions/:id/report", limit("report", 5, 60000), (req, res) => {
  const m = get("messages", req.params.id);
  if (!m || !m.public || m.hidden)
    return res.status(404).json({ error: "问题不存在" });
  put("reports", {
    id: randomUUID(),
    messageId: m.id,
    reason: String(req.body.reason || "请检查此内容").slice(0, 500),
    createdAt: new Date().toISOString(),
  });
  res.json({ ok: true });
});
function availableSurvey(req, res, next) {
  const s = get("surveys", req.params.id);
  if (!s || !s.published) return res.status(404).json({ error: "问卷不存在" });
  if (
    s.closed ||
    (s.startsAt && Date.now() < Date.parse(s.startsAt)) ||
    (s.endsAt && Date.now() > Date.parse(s.endsAt))
  )
    return res.status(403).json({ error: "问卷尚未开始或已结束" });
  req.survey = versionedSurvey(s);
  next();
}
app.get("/api/surveys/:id", availableSurvey, (req, res) =>
  res.json(req.survey),
);
app.post(
  "/api/surveys/:id/submit",
  (req, res, next) => {
    try {
      req.receipt = submissionReceipt("surveys:" + req.params.id, req.body);
      if (replayReceipt(req.receipt, res)) return;
      next();
    } catch (error) {
      next(error);
    }
  },
  availableSurvey,
  (req, res, next) => {
    try {
      if (
        typeof req.body.definitionVersion !== "string" ||
        req.body.definitionVersion !== req.survey.definitionVersion
      )
        throw Object.assign(
          Error("问卷内容已更新，请重新载入当前问卷再填写。此次回答尚未保存。"),
          { status: 409, code: "SURVEY_VERSION_CONFLICT" },
        );
      const answers = validateAnswers(req.survey, req.body.answers || {});
      const { termination } = surveyFlow(req.survey, answers);
      const completion = termination ? "terminated" : "completed";
      const submission = {
        id: randomUUID(),
        surveyId: req.survey.id,
        answers,
        questions: req.survey.questions,
        definitionVersion: req.survey.definitionVersion,
        surveyTitle: req.survey.title,
        completion,
        termination,
        createdAt: new Date().toISOString(),
      };
      const response = {
        message: termination
          ? req.survey.terminationMessage ||
            "感谢参与，你的回答已保存，问卷在此结束。"
          : req.survey.successMessage || "谢谢，你的回答已被保存。",
        completion,
        termination,
      };
      transaction(() => {
        // The assistant CLI can publish through another SQLite connection.
        // Recheck under the write lock so a new live definition cannot race
        // between the initial request validation and this answer's commit.
        const current = get("surveys", req.params.id);
        if (!current?.published)
          throw Object.assign(Error("问卷不存在"), { status: 404 });
        if (
          current.closed ||
          (current.startsAt && Date.now() < Date.parse(current.startsAt)) ||
          (current.endsAt && Date.now() > Date.parse(current.endsAt))
        )
          throw Object.assign(Error("问卷尚未开始或已结束"), { status: 403 });
        if (
          versionedSurvey(current).definitionVersion !==
          req.body.definitionVersion
        )
          throw Object.assign(
            Error(
              "问卷内容已更新，请重新载入当前问卷再填写。此次回答尚未保存。",
            ),
            { status: 409, code: "SURVEY_VERSION_CONFLICT" },
          );
        put("submissions", submission);
        saveReceipt(req.receipt, "submissions", submission.id, response);
      });
      res.status(201).json(response);
    } catch (e) {
      e.status ||= 400;
      next(e);
    }
  },
);
app.get("/api/surveys/:id/results", (req, res) => {
  const s = get("surveys", req.params.id);
  if (!s?.published || !s.publicResults)
    return res.status(404).json({ error: "结果未公开" });
  res.json({
    count: list("submissions").filter((x) => x.surveyId === s.id).length,
    completionCounts: surveyCompletionCounts(
      list("submissions").filter((x) => x.surveyId === s.id),
    ),
    summary: summarize(s),
  });
});
function summarize(s) {
  return summarizeSurvey(
    s,
    list("submissions").filter((x) => x.surveyId === s.id),
  );
}
app.get(
  "/api/geocode",
  limit("geo", 30, 60000),
  asyncRoute(async (req, res) => {
    const q = String(req.query.q || "").slice(0, 200);
    if (q.length < 2) return res.json([]);
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&accept-language=zh-CN&q=${encodeURIComponent(q)}`,
      {
        headers: { "User-Agent": "LinJiachengPersonalSpace/1.0" },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!r.ok) throw Error("地点服务暂时不可用");
    res.json(await r.json());
  }),
);
app.use("/api/admin", auth);
app.get("/api/admin", (req, res) => {
  const n = setting("notifications", {});
  res.json({
    profile: {
      ...setting("profile"),
      revision: revisionOf(setting("profile")),
    },
    projects: list("projects"),
    posts: list("posts"),
    stories: list("stories"),
    surveys: list("surveys").map(versionedSurvey),
    messages: list("messages").map(({ token, phraseHash, ...m }) => m),
    reports: list("reports"),
    outbox: list("outbox").map(({ token, ...j }) => j),
    notifications: {
      ...n,
      accessKeySecret: "",
      hasSecret: !!n.accessKeySecret,
    },
  });
});
app.put("/api/admin/password", (req, res) => {
  const a = setting("admin");
  const { current, next } = req.body;
  if (
    typeof current !== "string" ||
    typeof next !== "string" ||
    next.length < 12 ||
    !timingSafeEqual(
      Buffer.from(secretHash(current, a.salt), "hex"),
      Buffer.from(a.password, "hex"),
    )
  )
    return res.status(400).json({ error: "当前密码不正确，或新密码少于12位" });
  const salt = randomBytes(16).toString("hex");
  setSetting("admin", { ...a, salt, password: secretHash(next, salt) });
  sessions.clear();
  res.clearCookie("space_session");
  res.json({ ok: true });
});
app.get(
  "/api/admin/reverse",
  asyncRoute(async (req, res) => {
    const lat = Number(req.query.lat),
      lng = Number(req.query.lng);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      return res.status(400).json({ error: "坐标无效" });
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=zh-CN&lat=${lat}&lon=${lng}`,
      {
        headers: { "User-Agent": "LinJiachengPersonalSpace/1.0" },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!r.ok) throw Error("地点服务暂时不可用");
    const d = await r.json();
    res.json({
      city:
        d.address?.city || d.address?.town || d.address?.county || d.name || "",
      cityLat: Number(d.lat) || lat,
      cityLng: Number(d.lon) || lng,
      location: d.display_name || "",
    });
  }),
);
app.put("/api/admin/profile", (req, res, next) => {
  try {
    const profile = transaction(() => {
      const old = setting("profile");
      assertRevision(old, req.body.revision, "PROFILE_REVISION_CONFLICT");
      const saved = {
        ...normalizeProfile(old, req.body),
        revision: revisionOf(old) + 1,
      };
      setSetting("profile", saved);
      return saved;
    });
    res.json({ profile });
  } catch (error) {
    error.status ||= 400;
    next(error);
  }
});
app.put("/api/admin/notifications", (req, res) => {
  const old = setting("notifications", {});
  const b = req.body;
  const n = {
    ...old,
    ...b,
    accessKeySecret: b.accessKeySecret || old.accessKeySecret,
  };
  n.siteUrl = normalizeSiteOrigin(n.siteUrl, { allowEmpty: true });
  delete n.hasSecret;
  setSetting("notifications", n);
  res.json({ ok: true });
});
app.post("/api/admin/outbox/:id/retry", (req, res) => {
  retryNotification(req.params.id);
  void deliver();
  res.json({ ok: true });
});
for (const kind of ["projects", "posts", "stories"]) {
  app.get(`/api/admin/${kind}/:id`, (req, res) => {
    const record = get(kind, req.params.id);
    if (!record)
      return res.status(404).json({ error: "文章不存在，可能已被删除" });
    res.json(record);
  });
  app.put(`/api/admin/${kind}/:id/draft`, (req, res, next) => {
    try {
      res.json(
        saveContentDraft(
          { get, put, transaction },
          kind,
          req.params.id,
          req.body,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post(`/api/admin/${kind}/:id/publish`, (req, res, next) => {
    try {
      const saved = transitionContent(
        { get, put, transaction },
        kind,
        req.params.id,
        req.body,
        "publish",
      );
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });
  app.post(`/api/admin/${kind}/:id/unpublish`, (req, res, next) => {
    try {
      const saved = transitionContent(
        { get, put, transaction },
        kind,
        req.params.id,
        req.body,
        "unpublish",
      );
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });
}
for (const kind of ["projects", "posts", "stories", "surveys"]) {
  app.put(`/api/admin/${kind}/:id`, (req, res, next) => {
    try {
      const b = req.body;
      const id = req.params.id === "new" ? randomUUID() : req.params.id;
      if (kind !== "surveys") {
        const saved = transaction(() => {
          const old = get(kind, id);
          if (b.revision !== undefined) checkRevision(old, b.revision);
          const content = editableContent(b, old || {});
          validatePublication(kind, content, {
            requireLocationConfirmation:
              b.published === true ||
              (b.published === undefined && old?.published === true),
          });
          const { draft, draftSavedAt, ...previous } = old || {};
          return put(kind, {
            ...previous,
            ...content,
            id,
            published:
              typeof b.published === "boolean"
                ? b.published
                : Boolean(old?.published),
            revision: contentRevision(old) + 1,
            createdAt: old?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        });
        return res.json(saved);
      }
      const saved = transaction(() => {
        const old = get(kind, id);
        if (req.params.id !== "new" && !old)
          throw Object.assign(Error("问卷不存在，可能已被删除"), {
            status: 404,
          });
        if (old) assertRevision(old, b.revision, "SURVEY_REVISION_CONFLICT");
        validateSurvey(b);
        return put(
          kind,
          versionedSurvey({
            ...b,
            id,
            revision: revisionOf(old) + 1,
            createdAt: old?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        );
      });
      res.json(saved);
    } catch (e) {
      e.status ||= 400;
      next(e);
    }
  });
  app.delete(`/api/admin/${kind}/:id`, (req, res) => {
    remove(kind, req.params.id);
    res.json({ ok: true });
  });
}
app.put("/api/admin/messages/:id", (req, res) => {
  const m = get("messages", req.params.id);
  if (!m) return res.status(404).json({ error: "问题不存在" });
  const b = req.body;
  const updated = {
    ...m,
    hidden: b.hidden ?? m.hidden,
    reply: b.reply ?? m.reply,
    repliedAt: b.reply ? new Date().toISOString() : m.repliedAt,
  };
  if (updated.reply.length > 5000)
    return res.status(400).json({ error: "回复最多5000字" });
  put("messages", updated);
  if (b.reply && b.reply !== m.reply) {
    notify(m, b.reply);
    void deliver();
  }
  res.json({ ok: true });
});
app.delete("/api/admin/messages/:id", (req, res) => {
  const message = get("messages", req.params.id);
  transaction(() => {
    cancelNotifications(req.params.id, message?.token);
    eraseReceipts("messages", req.params.id);
    for (const report of list("reports"))
      if (report.messageId === req.params.id) remove("reports", report.id);
    remove("messages", req.params.id);
  });
  res.json({ ok: true });
});
app.delete("/api/admin/reports/:id", (req, res) => {
  remove("reports", req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/surveys/:id", (req, res) => {
  const survey = get("surveys", req.params.id);
  if (!survey)
    return res.status(404).json({ error: "问卷不存在，可能已被删除" });
  res.json(versionedSurvey(survey));
});
app.get("/api/admin/surveys/:id/results", (req, res) => {
  const s = get("surveys", req.params.id);
  if (!s) return res.status(404).json({ error: "问卷不存在" });
  res.json({
    rows: list("submissions").filter((x) => x.surveyId === s.id),
    completionCounts: surveyCompletionCounts(
      list("submissions").filter((x) => x.surveyId === s.id),
    ),
    summary: summarize(s),
  });
});
app.get(
  "/api/admin/surveys/:id/export",
  asyncRoute(async (req, res) => {
    const s = get("surveys", req.params.id);
    if (!s) return res.status(404).json({ error: "问卷不存在" });
    const rows = list("submissions").filter(
      (row) =>
        row.surveyId === s.id &&
        (!["completed", "terminated"].includes(req.query.completion) ||
          (row.completion === "terminated" ? "terminated" : "completed") ===
            req.query.completion),
    );
    const { headers, values } = surveyExport(s, rows);
    if (req.query.format === "csv") {
      const escape = (v) =>
        '"' +
        String(v)
          .replace(/^\s*[=+@-]/, "'$&")
          .replaceAll('"', '""') +
        '"';
      res
        .type("text/csv")
        .attachment("answers.csv")
        .send(
          "\uFEFF" +
            [headers, ...values]
              .map((r) => r.map(escape).join(","))
              .join("\r\n"),
        );
    } else {
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet("答卷");
      sheet.addRow(headers);
      values.forEach((r) => sheet.addRow(r));
      sheet.getRow(1).font = { bold: true };
      sheet.columns.forEach((c) => (c.width = 28));
      res
        .type(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .attachment("answers.xlsx");
      await wb.xlsx.write(res);
      res.end();
    }
  }),
);
registerMediaRoutes(app, auth);
if (process.argv.includes("--production")) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (req, res) => {
    if (req.path.startsWith("/api/") || /\.[a-z0-9]+$/i.test(req.path))
      return res.status(404).json({ error: "页面或文件不存在" });
    res.sendFile(resolve("dist/index.html"));
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({
    ...(err.code && /^[A-Z_]+$/.test(err.code)
      ? { code: err.code }
      : err.status === 409
        ? { code: "REVISION_CONFLICT" }
        : {}),
    error: [400, 409, 404].includes(err.status)
      ? err.message
      : err.code === "LIMIT_FILE_SIZE"
        ? "文件超过15MB"
        : err.status === 401
          ? "请登录"
          : "操作失败，请检查输入或稍后重试",
  });
  if (!process.env.TEST_MODE) console.error(err.message);
});
app.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`Personal Space: http://localhost:${port}`),
);
recoverNotificationJobs();
setInterval(() => void deliver(), 30000).unref();
setInterval(() => {
  for (const [k, v] of sessions) if (v < Date.now()) sessions.delete(k);
  for (const [k, v] of rates)
    if (v.every((t) => Date.now() - t > 3600000)) rates.delete(k);
}, 600000).unref();
