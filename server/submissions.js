import { get, put, list } from "./store.js";
import { fingerprint } from "./versions.js";

// An unpredictable browser-generated key is a capability to replay this result.
// Persist only its hash and an input digest, never a second copy of user input.
export function submissionReceipt(scope, body) {
  if (body.submissionKey === undefined) return null; // legacy clients
  const key = body.submissionKey;
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
    throw Object.assign(Error("提交标识无效，请重新打开填写页面。"), {
      status: 400,
    });
  const id = fingerprint([scope, key]);
  const digest = fingerprint(body);
  const saved = get("submissionReceipts", id);
  if (saved && saved.digest !== digest)
    throw Object.assign(
      Error("此提交标识已用于其他内容，请开始一次新的填写。"),
      { status: 409, code: "SUBMISSION_KEY_CONFLICT" },
    );
  return { id, digest, saved };
}
export function replayReceipt(receipt, res) {
  if (!receipt?.saved) return false;
  res.status(receipt.saved.status).json(receipt.saved.response);
  return true;
}
export function saveReceipt(
  receipt,
  resourceKind,
  resourceId,
  response,
  status = 201,
) {
  if (!receipt) return;
  put("submissionReceipts", {
    id: receipt.id,
    digest: receipt.digest,
    resourceKind,
    resourceId,
    status,
    response,
    createdAt: new Date().toISOString(),
  });
}
export function eraseReceipts(resourceKind, resourceId) {
  for (const receipt of list("submissionReceipts")) {
    if (
      receipt.resourceKind !== resourceKind ||
      receipt.resourceId !== resourceId
    )
      continue;
    put("submissionReceipts", {
      ...receipt,
      status: 410,
      response: { error: "这条记录已删除。", code: "RECORD_DELETED" },
    });
  }
}
