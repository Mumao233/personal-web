import express from "express";
import multer from "multer";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { resolve, extname } from "node:path";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import {
  dataDir,
  list,
  get,
  put,
  remove,
  setting,
  setSetting,
} from "./store.js";
import { validateSurvey, validateAnswers } from "./validation.js";
import { notify, deliver, normalizeContact } from "./notifications.js";
import { startAtlas } from "./atlas-gateway.js";
const app = express();
const port = Number(process.env.PORT || 5193);
const atlas = process.env.ATLAS_ENABLED === "0" || (process.env.TEST_MODE && process.env.ATLAS_ENABLED !== "1") ? null : await startAtlas();
if (process.env.TEST_MODE && atlas) {
  process.stdin.resume();
  process.stdin.once('end', () => { atlas.stop(); process.exit(0); });
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
  if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    new URL(req.headers.origin).host !== req.headers.host
  )
    return res.status(403).json({ error: "不允许跨站提交" });
  next();
});
// Public personal assets win only when a real public file exists. Never serve
// the private database directory; /data belongs exclusively to the Atlas.
app.use(express.static(resolve("public"), { index: false, dotfiles: "deny" }));
if (atlas) app.use(atlas.middleware);
app.use(express.json({ limit: "2mb" }));
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
app.get('/api/health', (req, res) => res.json({ application: 'personal-universe', atlas: Boolean(atlas?.live) }));
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
  if (setting("admin")) return res.status(409).json({ error: "管理员已设置" });
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
  )
    return res.status(403).json({ error: "首次设置请在服务器本地进行" });
  const { username, password } = req.body;
  if (!username?.trim() || typeof password !== "string" || password.length < 12)
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
    profile: setting("profile"),
    projects: list("projects").filter((x) => x.published),
    posts: list("posts").filter((x) => x.published),
    stories: list("stories").filter((x) => x.published),
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
app.post("/api/questions", limit("ask", 8, 60000), (req, res) => {
  if (!setting("profile").acceptQuestions)
    return res.status(403).json({ error: "提问暂时关闭" });
  const b = req.body;
  if (
    typeof b.question !== "string" ||
    !b.question.trim() ||
    b.question.length > 5000
  )
    return res.status(400).json({ error: "问题需为1至5000字" });
  if (!b.anonymous && (!b.name?.trim() || b.name.length > 80))
    return res.status(400).json({ error: "请填写署名（最多80字）" });
  const input = (b.recovery || "").trim();
  const contact = normalizeContact(input);
  const phrase =
    contact || !input ? randomBytes(12).toString("base64url") : input;
  if (phrase && phrase.length < 8)
    return res.status(400).json({ error: "私密字符串请使用至少8个字符" });
  if (phrase && list("messages").some((m) => m.phraseHash === hash(phrase)))
    return res.status(409).json({ error: "这个私密字符串已被使用，请换一个" });
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
  put("messages", m);
  res
    .status(201)
    .json({ link: `/?answer=${m.token}`, recoveryPhrase: phrase, id: m.id });
});
app.get("/api/answers/:token", (req, res) => {
  const m = list("messages").find((x) => x.token === req.params.token);
  if (!m) return res.status(404).json({ error: "链接无效" });
  res.json(publicMessage(m));
});
app.post("/api/recover", limit("recover", 5, 60000), (req, res) => {
  const key = String(req.body.key || "").trim();
  const contact = normalizeContact(key);
  if (contact) {
    for (const m of list("messages").filter(
      (x) => x.contact?.value === contact.value,
    ))
      notify(contact, m.reply || "问题已收到，暂未回复。", m.token);
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
  req.survey = s;
  next();
}
app.get("/api/surveys/:id", availableSurvey, (req, res) =>
  res.json(req.survey),
);
app.post("/api/surveys/:id/submit", availableSurvey, (req, res, next) => {
  try {
    const answers = validateAnswers(req.survey, req.body.answers || {});
    put("submissions", {
      id: randomUUID(),
      surveyId: req.survey.id,
      answers,
      questions: req.survey.questions,
      createdAt: new Date().toISOString(),
    });
    res
      .status(201)
      .json({
        message: req.survey.successMessage || "谢谢，你的回答已被保存。",
      });
  } catch (e) {
    e.status = 400;
    next(e);
  }
});
app.get("/api/surveys/:id/results", (req, res) => {
  const s = get("surveys", req.params.id);
  if (!s?.published || !s.publicResults)
    return res.status(404).json({ error: "结果未公开" });
  res.json({
    count: list("submissions").filter((x) => x.surveyId === s.id).length,
    summary: summarize(s),
  });
});
function summarize(s) {
  s = {
    ...s,
    questions: s.questions.map((q) => ({
      ...q,
      options: [
        ...new Set([...(q.options || []), ...(q.allowOther ? ["其他"] : [])]),
      ],
    })),
  };
  const rows = list("submissions").filter((x) => x.surveyId === s.id);
  return s.questions.map((q) => ({
    id: q.id,
    title: q.title,
    type: q.type,
    counts:
      q.type === "text"
        ? null
        : Object.fromEntries(
            (q.options || []).map((o) => [
              o,
              rows.filter((r) =>
                Array.isArray(r.answers[q.id])
                  ? r.answers[q.id].includes(o)
                  : r.answers[q.id] === o,
              ).length,
            ]),
          ),
    rank: q.type.includes("rank")
      ? Object.fromEntries(
          q.options.map((o) => {
            const positions = rows
              .filter(
                (r) =>
                  Array.isArray(r.answers[q.id]) && r.answers[q.id].includes(o),
              )
              .map((r) => r.answers[q.id].indexOf(o) + 1);
            return [
              o,
              positions.length
                ? Number(
                    (
                      positions.reduce((a, b) => a + b, 0) / positions.length
                    ).toFixed(2),
                  )
                : null,
            ];
          }),
        )
      : null,
    answered: rows.filter((r) => r.answers[q.id] != null).length,
  }));
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
    profile: setting("profile"),
    projects: list("projects"),
    posts: list("posts"),
    stories: list("stories"),
    surveys: list("surveys"),
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
app.put("/api/admin/profile", (req, res) => {
  const old = setting("profile");
  const b = req.body;
  if (!b.name?.trim()) return res.status(400).json({ error: "名字不能为空" });
  if (b.github && !/^https?:\/\//.test(b.github))
    return res.status(400).json({ error: "公开主页链接需要http或https" });
  setSetting("profile", { ...old, ...b });
  res.json({ ok: true });
});
app.put("/api/admin/notifications", (req, res) => {
  const old = setting("notifications", {});
  const b = req.body;
  if (b.siteUrl && !/^https?:\/\//.test(b.siteUrl))
    return res.status(400).json({ error: "网站地址需要http或https" });
  const n = {
    ...old,
    ...b,
    accessKeySecret: b.accessKeySecret || old.accessKeySecret,
  };
  delete n.hasSecret;
  setSetting("notifications", n);
  res.json({ ok: true });
});
app.post("/api/admin/outbox/:id/retry", (req, res) => {
  const j = get("outbox", req.params.id);
  if (!j) return res.status(404).json({ error: "任务不存在" });
  put("outbox", { ...j, status: "pending" });
  void deliver();
  res.json({ ok: true });
});
for (const kind of ["projects", "posts", "stories", "surveys"]) {
  app.put(`/api/admin/${kind}/:id`, (req, res, next) => {
    try {
      const b = req.body;
      const id = req.params.id === "new" ? randomUUID() : req.params.id;
      if (kind === "surveys") validateSurvey(b);
      else if (!b.title?.trim()) throw Error("标题不能为空");
      if (
        kind === "stories" &&
        (!Number.isFinite(Number(b.lat)) ||
          Number(b.lat) < -90 ||
          Number(b.lat) > 90 ||
          !Number.isFinite(Number(b.lng)) ||
          Number(b.lng) < -180 ||
          Number(b.lng) > 180)
      )
        throw Error("地点坐标无效");
      if (kind === "projects" && b.link && !/^https?:\/\//.test(b.link))
        throw Error("项目链接需要http或https");
      res.json(
        put(kind, {
          ...b,
          id,
          createdAt: get(kind, id)?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch (e) {
      e.status = 400;
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
    notify(m.contact, b.reply, m.token);
    void deliver();
  }
  res.json({ ok: true });
});
app.delete("/api/admin/messages/:id", (req, res) => {
  remove("messages", req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/reports/:id", (req, res) => {
  remove("reports", req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/surveys/:id/results", (req, res) => {
  const s = get("surveys", req.params.id);
  if (!s) return res.status(404).json({ error: "问卷不存在" });
  res.json({
    rows: list("submissions").filter((x) => x.surveyId === s.id),
    summary: summarize(s),
  });
});
app.get(
  "/api/admin/surveys/:id/export",
  asyncRoute(async (req, res) => {
    const s = get("surveys", req.params.id);
    if (!s) return res.status(404).json({ error: "问卷不存在" });
    const rows = list("submissions").filter((x) => x.surveyId === s.id);
    const questions = [
      ...new Map(
        [...s.questions, ...rows.flatMap((r) => r.questions || [])].map((q) => [
          q.id,
          q,
        ]),
      ).values(),
    ];
    const headers = ["提交编号", "时间", ...questions.map((q) => q.title)];
    const values = rows.map((r) => [
      r.id,
      r.createdAt,
      ...questions.map(
        (q) =>
          (Array.isArray(r.answers[q.id])
            ? r.answers[q.id].join(" → ")
            : r.answers[q.id] || "") +
          (r.answers[q.id + "__other"]
            ? " [其他：" + r.answers[q.id + "__other"] + "]"
            : ""),
      ),
    ]);
    if (req.query.format === "csv") {
      const escape = (v) =>
        '"' +
        String(v)
          .replace(/^[=+@-]/, "'$&")
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
const upload = multer({
  storage: multer.diskStorage({
    destination: resolve(dataDir, "uploads"),
    filename: (req, file, cb) =>
      cb(null, randomUUID() + extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) =>
    cb(null, /\.(jpg|jpeg|png|webp|gif|pdf)$/i.test(file.originalname)),
});
app.post("/api/admin/upload", upload.array("files", 20), (req, res) =>
  res.json({
    files: (req.files || []).map((f) => ({
      url: "/uploads/" + f.filename,
      name: f.originalname,
    })),
  }),
);
app.use(
  "/uploads",
  express.static(resolve(dataDir, "uploads"), {
    setHeaders: (res) =>
      res.set(
        "Content-Security-Policy",
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      ),
  }),
);
if (process.argv.includes("--production")) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (req, res) => {
    if (req.path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(req.path)) return res.status(404).json({ error: "页面或文件不存在" });
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
  res
    .status(err.status || 500)
    .json({
      error:
        err.status === 400
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
setInterval(() => void deliver(), 30000).unref();
setInterval(() => {
  for (const [k, v] of sessions) if (v < Date.now()) sessions.delete(k);
  for (const [k, v] of rates)
    if (v.every((t) => Date.now() - t > 3600000)) rates.delete(k);
}, 600000).unref();
