import { randomUUID } from "node:crypto";
import { checkRevision, contentRevision, editableContent } from "./content.js";

const kinds = new Set(["projects", "posts", "stories"]);

// Both the administrator and the local draft CLI take the lock BEFORE reading
// the revision. A second SQLite connection must never overwrite a stale read.
// The supplied store owns the transaction; this module has no DB initialization.
export function saveContentDraft(
  store,
  kind,
  id,
  input,
  { unpublishedOnly = false, dryRun = false } = {},
) {
  if (!kinds.has(kind))
    throw Object.assign(Error("不支持此内容类型"), { status: 400 });
  return store.transaction(() => {
    const isNew = id === "new";
    const old = isNew ? null : store.get(kind, id);
    if ((!isNew && !old) || (unpublishedOnly && old?.published))
      throw Object.assign(Error("未发布草稿不存在或不允许访问"), {
        status: 404,
      });
    checkRevision(old, input?.revision);
    const now = new Date().toISOString();
    const draft = editableContent(input, old?.draft || old || {});
    const record = {
      ...(old || {
        id: randomUUID(),
        title: "",
        body: "",
        published: false,
        createdAt: now,
      }),
      draft,
      draftSavedAt: now,
      revision: contentRevision(old) + 1,
    };
    // Live fields, publication flags and last-published dates stay unchanged.
    if (!dryRun) store.put(kind, record);
    return record;
  });
}
