// Shared content operations for the existing administrator and the local assistant.
// This module has no database initialization, network access, accounts or secrets.
import { randomUUID } from "node:crypto";
import {
  checkRevision,
  contentRevision,
  editableContent,
  validatePublication,
} from "./content.js";
import { saveContentDraft } from "./content-drafts.js";
import { normalizeProfile } from "./profile.js";
import { validateSurvey } from "./validation.js";
import { fingerprint, revisionOf, versionedSurvey } from "./versions.js";

export { saveContentDraft };
export const ADMIN_KINDS = Object.freeze([
  "posts",
  "projects",
  "stories",
  "profile",
  "surveys",
]);
const articles = new Set(["posts", "projects", "stories"]);
const common = [
  "title",
  "body",
  "content",
  "excerpt",
  "category",
  "date",
  "cover",
];
const fields = {
  posts: common,
  projects: [...common, "link", "status"],
  stories: [
    ...common,
    "location",
    "city",
    "lat",
    "lng",
    "cityLat",
    "cityLng",
    "confirmLocation",
    "photos",
  ],
  profile: [
    "name",
    "email",
    "phone",
    "wechat",
    "github",
    "portrait",
    "intro",
    "bio",
    "fields",
    "interests",
    "timeline",
    "acceptQuestions",
  ],
  surveys: [
    "title",
    "description",
    "questions",
    "closed",
    "publicResults",
    "successMessage",
    "terminationMessage",
    "startsAt",
    "endsAt",
  ],
};
const questionFields = [
  "id",
  "title",
  "type",
  "options",
  "required",
  "section",
  "description",
  "min",
  "max",
  "condition",
  "rows",
  "terminateOptions",
  "exclusiveOptions",
  "allowOther",
];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message, status = 400, code) => {
  throw Object.assign(Error(message), { status, ...(code ? { code } : {}) });
};
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => own(value || {}, key)).map((key) => [key, value[key]]),
  );
const clone = (value) => structuredClone(value);
const validation = (callback) => {
  try {
    return callback();
  } catch (error) {
    error.status ||= 400;
    throw error;
  }
};
function checkKind(kind) {
  if (!ADMIN_KINDS.includes(kind)) fail("不支持的内容模块");
}
function checkId(kind, id) {
  if (
    kind === "profile"
      ? id !== "profile"
      : typeof id !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id) ||
        id === "new"
  )
    fail("内容编号无效");
}
function keysOnly(value, allowed, label) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail(`${label}包含不支持的字段`);
}
function text(value, max, label) {
  if (typeof value !== "string" || value.length > max)
    fail(`${label}需为文字，最多${max}字`);
}
function bool(value, label) {
  if (typeof value !== "boolean") fail(`${label}需为布尔值`);
}
function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max)
    fail(`${label}格式无效或超过${max}项`);
}

function profileData(input, base = {}, { strict = true } = {}) {
  if (strict) keysOnly(input, fields.profile, "个人资料");
  const candidate = {
    email: "",
    phone: "",
    wechat: "",
    github: "",
    ...pick(base, fields.profile),
    ...pick(input, fields.profile),
  };
  for (const key of ["intro", "bio"])
    if (own(candidate, key))
      text(candidate[key], key === "bio" ? 20000 : 3000, key);
  if (own(candidate, "portrait")) text(candidate.portrait, 2000, "头像地址");
  if (own(candidate, "acceptQuestions"))
    bool(candidate.acceptQuestions, "接受提问");
  for (const [key, allowed] of [
    ["interests", ["title", "text", "status"]],
    ["timeline", ["date", "title", "text"]],
  ]) {
    if (!own(candidate, key)) continue;
    array(candidate[key], 100, key);
    candidate[key] = candidate[key].map((item) => {
      if (strict && own(input, key)) keysOnly(item, allowed, key);
      const value = pick(item, allowed);
      for (const entry of allowed)
        text(value[entry] ?? "", entry === "text" ? 10000 : 500, entry);
      return value;
    });
  }
  if (own(candidate, "fields")) {
    array(candidate.fields, 30, "资料栏目");
    const allowed = ["id", "key", "label", "value", "href", "visible"];
    candidate.fields = candidate.fields.map((item) => {
      if (strict && own(input, "fields")) keysOnly(item, allowed, "资料栏目");
      if (own(item || {}, "visible")) bool(item.visible, "资料栏目可见性");
      return pick(item, allowed);
    });
  }
  // The same profile validator as the normal administrator, with a bounded field
  // projection on both sides so arbitrary setting properties never cross here.
  return pick(
    validation(() => normalizeProfile({}, candidate)),
    fields.profile,
  );
}

function surveyData(input, base = {}, { strict = true } = {}) {
  if (strict) keysOnly(input, fields.surveys, "问卷");
  const result = {
    ...pick(base, fields.surveys),
    ...pick(input, fields.surveys),
  };
  for (const [key, max] of [
    ["title", 200],
    ["description", 10000],
    ["successMessage", 2000],
    ["terminationMessage", 2000],
    ["startsAt", 80],
    ["endsAt", 80],
  ])
    if (own(result, key)) text(result[key], max, key);
  for (const key of ["closed", "publicResults"])
    if (own(result, key)) bool(result[key], key);
  if (own(result, "questions")) {
    array(result.questions, 100, "问卷题目");
    result.questions = result.questions.map((question) => {
      if (strict && own(input, "questions"))
        keysOnly(question, questionFields, "问卷题目");
      const q = pick(question, questionFields);
      for (const [key, max] of [
        ["id", 120],
        ["title", 1000],
        ["section", 1000],
        ["description", 10000],
      ])
        if (own(q, key)) text(q[key], max, key);
      if (
        q.id &&
        (["__proto__", "constructor", "prototype"].includes(q.id) ||
          q.id.endsWith("__other"))
      )
        fail("题目编号无效");
      if (
        !["single", "multiple", "rank", "multirank", "text", "matrix"].includes(
          q.type,
        )
      )
        fail("不支持的题型");
      for (const key of ["required", "allowOther"])
        if (own(q, key)) bool(q[key], key);
      for (const key of ["min", "max"])
        if (
          own(q, key) &&
          (!Number.isInteger(q[key]) || q[key] < 0 || q[key] > 100)
        )
          fail("选项数量范围无效");
      for (const key of ["options", "terminateOptions", "exclusiveOptions"])
        if (own(q, key)) {
          array(q[key], 100, key);
          q[key].forEach((option) => text(option, 1000, "选项"));
        }
      if (q.condition != null) {
        if (strict && own(input, "questions"))
          keysOnly(q.condition, ["questionId", "value"], "题目条件");
        q.condition = pick(q.condition, ["questionId", "value"]);
        text(q.condition.questionId, 120, "条件题号");
        text(q.condition.value, 1000, "条件值");
      }
      if (own(q, "rows")) {
        array(q.rows, 50, "矩阵行");
        q.rows = q.rows.map((row) => {
          if (strict && own(input, "questions"))
            keysOnly(row, ["id", "title"], "矩阵行");
          text(row.id, 120, "矩阵行编号");
          text(row.title, 1000, "矩阵行标题");
          return pick(row, ["id", "title"]);
        });
      }
      return q;
    });
  }
  for (const key of ["startsAt", "endsAt"])
    if (result[key] && !Number.isFinite(Date.parse(result[key])))
      fail("时间格式无效");
  if (
    result.startsAt &&
    result.endsAt &&
    Date.parse(result.startsAt) >= Date.parse(result.endsAt)
  )
    fail("截止时间须晚于开始时间");
  return result;
}

function projectData(kind, value) {
  if (!value) return null;
  if (kind === "profile")
    return profileData(pick(value, fields.profile), {}, { strict: false });
  if (kind === "surveys")
    return surveyData(pick(value, fields.surveys), {}, { strict: false });
  return pick(editableContent(pick(value, fields[kind])), fields[kind]);
}
function normalizedData(kind, input, base) {
  keysOnly(input, fields[kind], "内容");
  if (kind === "profile") return profileData(input, base);
  if (kind === "surveys") return surveyData(input, base);
  let content = input;
  if (own(input, "body") && !own(input, "content")) {
    text(input.body, 200000, "正文");
    content = {
      ...input,
      content: {
        type: "doc",
        content: input.body
          .split(/\r?\n\s*\r?\n/)
          .map((paragraph) => ({
            type: "paragraph",
            content: paragraph
              .split(/\r?\n/)
              .flatMap((line, index) => [
                ...(index ? [{ type: "hardBreak" }] : []),
                ...(line ? [{ type: "text", text: line }] : []),
              ]),
          })),
      },
    };
  }
  return pick(editableContent(content, base), fields[kind]);
}
function source(store, kind, id) {
  const live =
    kind === "profile" ? store.setting("profile") : store.get(kind, id);
  const stage = articles.has(kind)
    ? null
    : store.get("assistant_drafts", `${kind}:${id}`);
  if (!live && !stage?.data) fail("内容不存在", 404);
  return { live: live || null, stage: stage || null };
}

export function adminTarget(kind, id) {
  checkKind(kind);
  checkId(kind, id);
  if (kind === "profile") return "https://mumao.site/?page=about";
  return `https://mumao.site/?${{ posts: "post", projects: "project", stories: "story", surveys: "survey" }[kind]}=${encodeURIComponent(id)}`;
}
export function adminGet(store, kind, id) {
  checkKind(kind);
  checkId(kind, id);
  const { live, stage } = source(store, kind, id);
  const draft = articles.has(kind) ? live?.draft : stage?.data;
  return clone({
    kind,
    id,
    version: fingerprint({ live, stage }),
    liveRevision: revisionOf(live),
    published: kind === "profile" ? Boolean(live) : Boolean(live?.published),
    hasDraft: Boolean(draft),
    draft: projectData(kind, draft),
    live: projectData(kind, live),
    stale: Boolean(stage?.data && stage.baseFingerprint !== fingerprint(live)),
    target: adminTarget(kind, id),
  });
}
export function adminList(store, kind) {
  checkKind(kind);
  if (kind === "profile") return [adminGet(store, kind, "profile")];
  const ids = new Set(store.list(kind).map((record) => record.id));
  if (kind === "surveys")
    for (const stage of store.list("assistant_drafts"))
      if (stage.kind === kind && stage.data) ids.add(stage.targetId);
  return [...ids].map((id) => adminGet(store, kind, id));
}

// Shared article transitions preserve the HTTP administrator's revision contract.
export function transitionContent(store, kind, id, input, action) {
  if (!articles.has(kind) || !["publish", "unpublish"].includes(action))
    fail("不支持的文章操作");
  return store.transaction(() => {
    const old = store.get(kind, id);
    if (!old) fail("文章不存在", 404);
    checkRevision(old, input?.revision);
    const now = new Date().toISOString();
    if (action === "unpublish")
      return store.put(kind, {
        ...old,
        published: false,
        revision: contentRevision(old) + 1,
        updatedAt: now,
      });
    const content = editableContent(old.draft || old);
    validatePublication(kind, content);
    const { draft, draftSavedAt, ...live } = old;
    return store.put(kind, {
      ...live,
      ...content,
      published: true,
      publishedAt: old.publishedAt || now,
      updatedAt: now,
      revision: contentRevision(old) + 1,
    });
  });
}

export function adminMutate(store, operation) {
  keysOnly(
    operation,
    [
      "action",
      "kind",
      "id",
      "expectedVersion",
      "data",
      "target",
      "allowBioChange",
      "resolveStale",
    ],
    "操作",
  );
  const { action, kind } = operation;
  checkKind(kind);
  if (!["create", "update", "publish", "unpublish"].includes(action))
    fail("不支持的内容操作");
  if (own(operation, "allowBioChange"))
    bool(operation.allowBioChange, "简介修改授权");
  if (own(operation, "resolveStale"))
    bool(operation.resolveStale, "草稿合并确认");
  if (own(operation, "resolveStale") && action !== "update")
    fail("只有修改草稿时可以合并过期草稿");
  if (kind === "profile" && ["create", "unpublish"].includes(action))
    fail("个人资料不支持新建或整页下架");
  if (
    action === "create" &&
    (operation.id !== undefined || operation.expectedVersion !== undefined)
  )
    fail("新建操作不能指定编号或已有版本");
  if (!["create", "update"].includes(action) && operation.data !== undefined)
    fail("发布和下架不能同时修改正文，请先保存草稿并预览");
  if (
    !["publish", "unpublish"].includes(action) &&
    operation.target !== undefined
  )
    fail("只有发布和下架操作可以指定发布目标");
  return store.transaction(() => {
    const locked = { ...store, transaction: (callback) => callback() };
    let id = action === "create" ? randomUUID() : operation.id;
    checkId(kind, id);
    let view,
      live = null,
      stage = null;
    if (action !== "create") {
      view = adminGet(locked, kind, id);
      if (
        typeof operation.expectedVersion !== "string" ||
        operation.expectedVersion !== view.version
      )
        fail("内容版本已变化，请重新读取并核对修改", 409, "REVISION_CONFLICT");
      ({ live, stage } = source(locked, kind, id));
      if (
        ["publish", "unpublish"].includes(action) &&
        operation.target !== view.target
      )
        fail("发布或下架目标必须与预览中的本站内容地址完全一致");
    }
    const now = new Date().toISOString();
    if (["create", "update"].includes(action)) {
      if (view?.stale) {
        if (operation.resolveStale !== true)
          fail(
            "正式内容已更新，请核对正式版与助手草稿后明确提交完整合并稿",
            409,
            "STALE_DRAFT",
          );
        const allKeys = new Set([
          ...Object.keys(view.live || {}),
          ...Object.keys(view.draft || {}),
        ]);
        if (
          !object(operation.data) ||
          [...allKeys].some((key) => !own(operation.data, key))
        )
          fail("合并过期草稿必须提交正式版和草稿中全部现有可编辑字段");
      } else if (own(operation, "resolveStale"))
        fail("当前草稿未过期，无需合并确认");
      const base =
        (view?.stale ? view.live : view?.draft || view?.live) ||
        (kind === "surveys"
          ? {
              title: "",
              description: "",
              questions: [],
              closed: false,
              publicResults: false,
              startsAt: "",
              endsAt: "",
              successMessage: "谢谢，你的回答已被保存。",
              terminationMessage: "感谢你的参与，本次问卷到这里结束。",
            }
          : {});
      const data = normalizedData(kind, operation.data ?? {}, base);
      if (
        kind === "profile" &&
        ["intro", "bio"].some((key) => data[key] !== view.live[key]) &&
        operation.allowBioChange !== true
      )
        fail(
          "修改简介或个人自述需要明确授权",
          400,
          "BIO_CHANGE_REQUIRES_CONFIRMATION",
        );
      if (articles.has(kind))
        id = saveContentDraft(locked, kind, action === "create" ? "new" : id, {
          ...data,
          revision: revisionOf(live),
        }).id;
      else
        store.put("assistant_drafts", {
          id: `${kind}:${id}`,
          kind,
          targetId: id,
          data,
          baseFingerprint: fingerprint(live),
          savedAt: now,
        });
    } else if (action === "publish") {
      if (view.stale)
        fail(
          "后台已更新正式内容，请先重新核对并保存助手草稿",
          409,
          "STALE_DRAFT",
        );
      const data = view.draft || view.live;
      if (
        kind === "profile" &&
        ["intro", "bio"].some((key) => data[key] !== view.live[key]) &&
        operation.allowBioChange !== true
      )
        fail(
          "发布简介或个人自述修改需要明确授权",
          400,
          "BIO_CHANGE_REQUIRES_CONFIRMATION",
        );
      if (articles.has(kind))
        transitionContent(
          locked,
          kind,
          id,
          { revision: revisionOf(live) },
          "publish",
        );
      else {
        if (!view.hasDraft) fail("没有待发布的助手草稿");
        if (kind === "profile")
          store.setSetting("profile", {
            ...live,
            ...profileData(data),
            revision: revisionOf(live) + 1,
          });
        else {
          validation(() => validateSurvey(data));
          store.put(
            "surveys",
            versionedSurvey({
              ...live,
              ...data,
              id,
              published: true,
              revision: revisionOf(live) + 1,
              createdAt: live?.createdAt || now,
              publishedAt: live?.publishedAt || now,
              updatedAt: now,
            }),
          );
        }
        store.put("assistant_drafts", {
          id: `${kind}:${id}`,
          kind,
          targetId: id,
          data: null,
          savedAt: now,
        });
      }
    } else if (articles.has(kind))
      transitionContent(
        locked,
        kind,
        id,
        { revision: revisionOf(live) },
        "unpublish",
      );
    else {
      if (!live) fail("此问卷尚未发布", 400);
      store.put("surveys", {
        ...live,
        published: false,
        revision: revisionOf(live) + 1,
        updatedAt: now,
      });
      // Withdrawing does not change the definition; a previously current draft
      // remains current, while an already stale draft remains stale.
      if (stage?.data && !view.stale)
        store.put("assistant_drafts", {
          ...stage,
          baseFingerprint: fingerprint(store.get("surveys", id)),
        });
    }
    return {
      ...adminGet(locked, kind, id),
      ...(action === "publish" ? { url: adminTarget(kind, id) } : {}),
    };
  });
}
