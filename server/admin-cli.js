// A local operational entry point, not a new authentication boundary.
// Never import store.js: this tool must not initialize or seed a database.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fingerprint } from "./versions.js";
import { decodeBase64 } from "./base64.js";
import { adminGet, adminList, adminMutate } from "./admin-content.js";
import { calendarDateAt } from "../shared/content-date.js";
import {
  prepareMedia,
  savePreparedMedia,
  loadPreviewMedia,
  validateContentMedia,
} from "./media-processing.js";

const fail = (message, status = 400, code = "INVALID_REQUEST") => {
  throw Object.assign(new Error(message), { status, code });
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const kinds = new Set(["posts", "projects", "stories", "surveys", "profile"]);
const ownKeys = (value, allowed) => {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail("请求包含未知字段或格式无效");
};
const validId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
const requestId = (value) => {
  if (!validId(value) || value.length < 8)
    fail("requestId 需要 8 至 100 位字母、数字、横线或下划线");
};
function operationsFor(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20)
    fail("每次需要 1 至 20 项操作");
  const targets = new Set();
  for (const operation of input) {
    ownKeys(operation, [
      "action",
      "kind",
      "id",
      "expectedVersion",
      "data",
      "target",
      "allowBioChange",
      "resolveStale",
    ]);
    if (
      !["create", "update", "publish", "unpublish"].includes(
        operation.action,
      ) ||
      !kinds.has(operation.kind)
    )
      fail("不支持此模块或操作");
    if (
      operation.allowBioChange !== undefined &&
      typeof operation.allowBioChange !== "boolean"
    )
      fail("allowBioChange 必须是布尔值");
    if (
      operation.resolveStale !== undefined &&
      typeof operation.resolveStale !== "boolean"
    )
      fail("resolveStale 必须是布尔值");
    if (operation.action === "create") {
      if (operation.id !== undefined || operation.expectedVersion !== undefined)
        fail("新建不能指定 ID 或版本");
    } else {
      if (
        !validId(operation.id) ||
        typeof operation.expectedVersion !== "string" ||
        !/^[a-f0-9]{64}$/.test(operation.expectedVersion)
      )
        fail("修改需要内容 ID 和刚读取的 expectedVersion");
      const key = operation.kind + ":" + operation.id;
      if (targets.has(key)) fail("同一批不能多次操作同一内容");
      targets.add(key);
    }
    if (["create", "update"].includes(operation.action)) {
      if (!object(operation.data)) fail("保存草稿需要 data 对象");
      if (operation.target !== undefined) fail("保存草稿不能指定发布目标");
    } else {
      if (operation.data !== undefined) fail("发布或下架不能同时修改正文");
      if (typeof operation.target !== "string")
        fail("发布或下架需要明确目标 target");
    }
  }
  return input;
}

function databaseStore(db, { overlay = false, dataDir } = {}) {
  const records = new Map(),
    settings = new Map();
  return {
    validateContentMedia: (kind, content) => validateContentMedia(dataDir, kind, content),
    get(kind, id) {
      const key = JSON.stringify([kind, id]);
      if (records.has(key)) return structuredClone(records.get(key));
      const row = db
        .prepare("SELECT body FROM records WHERE kind=? AND id=?")
        .get(kind, id);
      return row ? JSON.parse(row.body) : null;
    },
    list(kind) {
      const rows = db
        .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind)
        .map((row) => JSON.parse(row.body));
      if (!overlay) return rows;
      const items = new Map(rows.map((row) => [row.id, row]));
      for (const [key, value] of records) {
        const [type, id] = JSON.parse(key);
        if (type === kind) items.set(id, structuredClone(value));
      }
      return [...items.values()];
    },
    put(kind, value) {
      if (overlay)
        records.set(JSON.stringify([kind, value.id]), structuredClone(value));
      else
        db.prepare(
          "INSERT INTO records (kind,id,body) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
        ).run(kind, value.id, JSON.stringify(value));
      return value;
    },
    setting(key, fallback = null) {
      if (settings.has(key)) return structuredClone(settings.get(key));
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
      return row ? JSON.parse(row.value) : fallback;
    },
    setSetting(key, value) {
      if (overlay) settings.set(key, structuredClone(value));
      else
        db.prepare(
          "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(key, JSON.stringify(value));
    },
    // The caller already owns one read snapshot / BEGIN IMMEDIATE transaction.
    transaction: (callback) => callback(),
  };
}

function stateBefore(store, operations) {
  return operations.map((operation) =>
    operation.action === "create"
      ? null
      : adminGet(store, operation.kind, operation.id),
  );
}
function previewHash(operations, before, expiresAt) {
  return fingerprint({
    operations,
    versions: before.map((view) => view?.version ?? null),
    expiresAt,
    publicationDay: calendarDateAt(new Date().toISOString()),
  });
}
function changedKeys(before, after) {
  const old = before?.draft ?? before?.live ?? {};
  const next = after?.draft ?? after?.live ?? {};
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(
    (key) => fingerprint(old[key] ?? null) !== fingerprint(next[key] ?? null),
  );
}
function receipt(store, id, hash) {
  const existing = store.get("assistant_receipts", id);
  if (!existing) return null;
  if (existing.hash !== hash)
    fail(
      "相同 requestId 已用于不同请求，不能重新使用",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  return { ...existing.result, replayed: true };
}
function persistReceipt(store, id, hash, result) {
  store.put("assistant_receipts", {
    id,
    hash,
    result,
    completedAt: new Date().toISOString(),
  });
}

export async function executeAdminRequest(dataDir, request) {
  if (!dataDir || !isAbsolute(dataDir)) fail("必须显式设置绝对路径 DATA_DIR");
  const path = resolve(dataDir, "space.sqlite");
  if (!existsSync(path))
    fail("目标数据库不存在；不会新建或初始化数据库", 404, "NOT_FOUND");
  if (!object(request)) fail("输入必须为 JSON 对象");
  const action = request.action;
  const fields = {
    list: ["action", "kind", "offset", "limit"],
    get: ["action", "kind", "id"],
    preview: ["action", "operations"],
    apply: [
      "action",
      "requestId",
      "operations",
      "previewToken",
      "previewExpiresAt",
      "approved",
    ],
    "media-upload": ["action", "requestId", "files"],
    "media-get": ["action", "names"],
  };
  if (typeof action !== "string" || !Object.hasOwn(fields, action))
    fail("不支持此操作；不提供删除、答卷、问答、账号、SQL 或系统命令入口");
  ownKeys(request, fields[action]);
  const readOnly = !["apply", "media-upload"].includes(action);
  const db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA busy_timeout=5000");
  let transaction = false,
    savedMedia;
  try {
    const store = databaseStore(db, { dataDir });
    if (action === "media-get") {
      return {
        ok: true,
        files: await loadPreviewMedia(dataDir, request.names),
      };
    }
    let prepared;
    if (action === "media-upload") {
      requestId(request.requestId);
      if (
        !Array.isArray(request.files) ||
        !request.files.length ||
        request.files.length > 20
      )
        fail("上传需要 1 至 20 个文件");
      let total = 0;
      const files = request.files.map((file) => {
        ownKeys(file, ["name", "base64"]);
        if (typeof file.name !== "string") fail("文件需要名称和有效 base64");
        const buffer = decodeBase64(file.base64);
        total += buffer.length;
        if (buffer.length > 15 * 1024 * 1024 || total > 30 * 1024 * 1024)
          fail("每文件最多 15 MiB，每次合计最多 30 MiB");
        return { name: file.name, buffer };
      });
      // Decode/sanitize before acquiring the SQLite write lock.
      prepared = await prepareMedia(files);
    }
    db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    transaction = true;
    let result;
    if (action === "list" || action === "get") {
      if (!kinds.has(request.kind)) fail("仅支持五类内容模块");
      if (action === "get") {
        if (!validId(request.id)) fail("内容 ID 无效");
        result = { ok: true, item: adminGet(store, request.kind, request.id) };
      } else {
        const offset = request.offset ?? 0,
          limit = request.limit ?? 50;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          fail("分页参数无效，limit 为 1 至 100");
        const items = adminList(store, request.kind);
        result = {
          ok: true,
          total: items.length,
          offset,
          items: items
            .slice(offset, offset + limit)
            .map(({ draft, live, ...meta }) => ({
              ...meta,
              title: (draft ?? live)?.title || (draft ?? live)?.name || "",
            })),
        };
      }
    } else if (action === "media-upload") {
      const hash = fingerprint(request);
      result = receipt(store, request.requestId, hash);
      if (!result) {
        savedMedia = await savePreparedMedia(dataDir, prepared, {
          operationId: request.requestId,
        });
        result = { ok: true, files: savedMedia.files, replayed: false };
        persistReceipt(store, request.requestId, hash, result);
      }
    } else {
      const operations = operationsFor(request.operations);
      const requiresPreview =
        operations.length > 1 ||
        operations.some((op) => ["publish", "unpublish"].includes(op.action));
      const hash = fingerprint({ action: "apply", operations });
      if (action === "apply") {
        requestId(request.requestId);
        if (
          request.approved !== undefined &&
          typeof request.approved !== "boolean"
        )
          fail("approved 必须是布尔值");
        if (requiresPreview && request.approved !== true)
          fail("须先展示预览并取得用户明确确认", 400, "APPROVAL_REQUIRED");
        result = receipt(store, request.requestId, hash);
      }
      if (!result) {
        const before = stateBefore(store, operations);
        if (action === "preview") {
          const simulation = databaseStore(db, { overlay: true, dataDir });
          const views = operations.map((operation) =>
            adminMutate(simulation, operation),
          );
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          result = {
            ok: true,
            preview: {
              token: previewHash(operations, before, expiresAt),
              expiresAt,
              impactCount: operations.length,
              items: views.map((view, index) => ({
                ...view,
                action: operations[index].action,
                version: before[index]?.version ?? null,
                draft:
                  operations[index].action === "unpublish"
                    ? before[index]?.live
                    : (view.draft ?? view.live),
                live: before[index]?.live ?? null,
                changes: changedKeys(
                  operations[index].action === "publish"
                    ? { live: before[index]?.live }
                    : before[index],
                  view,
                ),
                ...(operations[index].action === "create"
                  ? { id: null, target: null, version: null }
                  : {}),
              })),
            },
          };
        } else {
          if (requiresPreview) {
            const expires = Date.parse(request.previewExpiresAt);
            if (
              !Number.isFinite(expires) ||
              expires <= Date.now() ||
              expires > Date.now() + 30 * 60 * 1000 ||
              request.previewToken !==
                previewHash(operations, before, request.previewExpiresAt)
            )
              fail(
                "预览已过期或内容/目标已改变，请重新预览",
                409,
                "PREVIEW_CONFLICT",
              );
          }
          const results = operations.map((operation) =>
            adminMutate(store, operation),
          );
          result = { ok: true, results, replayed: false };
          persistReceipt(store, request.requestId, hash, result);
        }
      }
    }
    db.exec("COMMIT");
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    if (savedMedia) await savedMedia.rollback();
    throw error;
  } finally {
    db.close();
  }
}

export function safeError(error) {
  const status = [400, 404, 409, 413].includes(error.status)
    ? error.status
    : 500;
  return {
    ok: false,
    status,
    code:
      status === 500
        ? "OPERATION_FAILED"
        : error.code ||
          (status === 409 ? "REVISION_CONFLICT" : "INVALID_REQUEST"),
    error:
      status === 500
        ? "管理操作失败；请检查执行环境，使用原 requestId 核实结果"
        : error.message,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 2) fail("参数不支持；请通过标准输入传入 JSON");
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 42 * 1024 * 1024) fail("请求超过 42 MiB", 413);
      chunks.push(chunk);
    }
    let request;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("标准输入不是有效 JSON");
    }
    if (!object(request)) fail("输入必须为 JSON 对象");
    if (request.action !== "media-upload" && size > 1024 * 1024)
      fail("内容请求不能超过 1 MiB", 413);
    console.log(
      JSON.stringify(await executeAdminRequest(process.env.DATA_DIR, request)),
    );
  } catch (error) {
    console.log(JSON.stringify(safeError(error)));
    process.exitCode = 1;
  }
}
