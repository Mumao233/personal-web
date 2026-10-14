// Local JSON CLI only. No HTTP routes, accounts, passwords or API keys.
// In particular, do not import store.js: its first-run seeding is not read-only.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { editableContent, contentRevision } from "./content.js";
import { saveContentDraft } from "./content-drafts.js";

const fields = new Set([
  "title",
  "body",
  "content",
  "excerpt",
  "category",
  "date",
]);
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};

function argumentsFor(argv) {
  const args = [...argv];
  const dryRun = args.at(-1) === "--dry-run";
  if (dryRun) args.pop();
  const [operation, id] = args;
  if (
    !["list", "get", "create", "update"].includes(operation) ||
    args.length !== (["get", "update"].includes(operation) ? 2 : 1) ||
    (dryRun && !["create", "update"].includes(operation)) ||
    (id !== undefined &&
      (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id) || id === "new"))
  )
    fail("只支持 list、get ID、create、update ID；写入可追加 --dry-run");
  return { operation, id, dryRun };
}

async function inputFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) fail("输入 JSON 不能超过 1 MiB");
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("标准输入需要有效的 JSON 对象");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("标准输入需要 JSON 对象");
  if (Object.keys(input).some((key) => key !== "revision" && !fields.has(key)))
    fail("仅接受 revision、title、body、content、excerpt、category、date");
  // Validate lengths/types before deriving structured plain text. Content is
  // authoritative when both representations are explicitly supplied. Date
  // format validation needs the locked existing draft: legacy authored dates
  // may be echoed unchanged, but new or changed dates must be calendar dates.
  const { date, ...content } = input;
  if (Object.hasOwn(input, "date") && (typeof date !== "string" || date.length > 40))
    fail("date格式无效或过长");
  editableContent(content);
  if (Object.hasOwn(input, "body") && !Object.hasOwn(input, "content")) {
    input.content = {
      type: "doc",
      content: input.body.split(/\r?\n\s*\r?\n/).map((paragraph) => ({
        type: "paragraph",
        content: paragraph
          .split(/\r?\n/)
          .flatMap((line, index) => [
            ...(index ? [{ type: "hardBreak" }] : []),
            ...(line ? [{ type: "text", text: line }] : []),
          ]),
      })),
    };
  }
  return input;
}

function draftView(record) {
  const source = editableContent({}, record.draft || record, { kind: "posts" });
  return {
    id: record.id,
    revision: contentRevision(record),
    draftSavedAt: record.draftSavedAt || null,
    ...Object.fromEntries(
      [...fields]
        .filter((key) => Object.hasOwn(source, key))
        .map((key) => [key, source[key]]),
    ),
  };
}

let db;
try {
  const { operation, id, dryRun } = argumentsFor(process.argv.slice(2));
  const dataDir = process.env.DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir)) fail("必须显式设置绝对路径 DATA_DIR");
  const path = resolve(dataDir, "space.sqlite");
  if (!existsSync(path)) fail("目标数据库不存在；本工具不会初始化数据库", 404);
  const input = ["create", "update"].includes(operation)
    ? await inputFromStdin()
    : null;
  const readOnly = ["list", "get"].includes(operation) || dryRun;
  db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA busy_timeout=5000");
  const store = {
    get(kind, recordId) {
      if (kind !== "posts") fail("仅允许随笔草稿");
      const row = db
        .prepare("SELECT body FROM records WHERE kind='posts' AND id=?")
        .get(recordId);
      return row ? JSON.parse(row.body) : null;
    },
    put(kind, record) {
      if (kind !== "posts" || readOnly || record.published)
        fail("仅允许保存未发布随笔草稿");
      db.prepare(
        "INSERT INTO records (kind,id,body) VALUES ('posts',?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      ).run(record.id, JSON.stringify(record));
    },
    transaction(callback) {
      db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const result = callback();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let result;
  if (operation === "list") {
    const drafts = db
      .prepare(
        "SELECT body FROM records WHERE kind='posts' ORDER BY rowid DESC",
      )
      .all()
      .map((row) => JSON.parse(row.body))
      .filter((record) => !record.published)
      .map((record) => {
        const view = draftView(record);
        return {
          id: view.id,
          revision: view.revision,
          title: view.title || "",
          draftSavedAt: view.draftSavedAt,
        };
      });
    result = { drafts };
  } else if (operation === "get") {
    const record = store.get("posts", id);
    if (!record || record.published) fail("未发布草稿不存在或不允许访问", 404);
    result = { draft: draftView(record) };
  } else {
    result = store.transaction(() => {
      const record = saveContentDraft(
        { ...store, transaction: callback => callback() },
        "posts",
        operation === "create" ? "new" : id,
        input,
        { unpublishedOnly: true, dryRun },
      );
      // Project the response before COMMIT, so a projection error cannot report
      // failure after successfully persisting a revision the caller did not see.
      return dryRun
        ? {
            dryRun: true,
            operation,
            id: operation === "create" ? null : id,
            revision: record.revision - 1,
            nextRevision: record.revision,
          }
        : { draft: draftView(record) };
    });
  }
  console.log(JSON.stringify({ ok: true, kind: "posts", ...result }));
} catch (error) {
  const status = [400, 404, 409].includes(error.status) ? error.status : 500;
  console.log(
    JSON.stringify({
      ok: false,
      status,
      ...(status === 409 ? { code: "REVISION_CONFLICT" } : {}),
      error:
        status === 500 ? "草稿操作失败，请检查本机运行环境" : error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
