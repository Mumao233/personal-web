import RPCClient from "@alicloud/pop-core";
import { list, get, put, setting } from "./store.js";
import { randomUUID } from "node:crypto";

export function normalizeContact(value = "") {
  if (typeof value !== "string" || value.length > 320) return null;
  value = value.trim().toLowerCase();
  const at = value.indexOf("@");
  // Bounded, linear scans instead of ambiguous repeated regexp groups.
  if (
    at > 0 &&
    at <= 64 &&
    at === value.lastIndexOf("@") &&
    !/\s/.test(value)
  ) {
    const domain = value.slice(at + 1);
    const dot = domain.lastIndexOf(".");
    if (dot > 0 && dot < domain.length - 1 && domain.length <= 253)
      return { type: "email", value };
  }
  const digits = value.replace(/[\s-]/g, "").replace(/^\+86/, "");
  if (/^1[3-9]\d{9}$/.test(digits)) return { type: "sms", value: digits };
  return null;
}
export function normalizeSiteOrigin(value, { allowEmpty = false } = {}) {
  if ((value === undefined || value === "") && allowEmpty) return "";
  try {
    if (typeof value !== "string" || value.length > 2000) throw Error();
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)
    )
      throw Error();
    return url.origin;
  } catch {
    throw Object.assign(
      Error("请配置有效的公网网站地址（http 或 https 域名／公网 IP）。"),
      { status: 400 },
    );
  }
}
export function notificationLink(config, token) {
  const url = new URL(normalizeSiteOrigin(config.siteUrl));
  url.searchParams.set("answer", token);
  return url.href;
}
const version = (job) =>
  Number.isSafeInteger(job?.revision) ? job.revision : 0;
const ownerOf = (job) =>
  job.messageId
    ? get("messages", job.messageId)
    : list("messages").find((message) => message.token === job.token);
function cancelled(job) {
  // Tombstones keep task identity, never the deleted reply/contact/access token.
  return {
    id: job.id,
    messageId: job.messageId || null,
    status: "cancelled",
    attempts: job.attempts || 0,
    createdAt: job.createdAt,
    cancelledAt: new Date().toISOString(),
    revision: version(job) + 1,
  };
}
export function cancelNotifications(messageId, token) {
  for (const job of list("outbox")) {
    if (job.messageId === messageId || (token && job.token === token))
      put("outbox", cancelled(job));
  }
}
export function recoverNotificationJobs() {
  for (const job of list("outbox")) {
    if (job.status === "cancelled") continue;
    const owner = ownerOf(job);
    if (!owner) {
      put("outbox", cancelled(job));
      continue;
    }
    const changes = { ...job, messageId: owner.id, revision: version(job) };
    if (job.status === "sending") {
      changes.status = "failed";
      changes.error =
        "服务在发送期间重启；交付状态未知，请确认后手动重试，避免重复通知。";
      changes.revision++;
      delete changes.attemptId;
    }
    put("outbox", changes);
  }
}
export function notify(message, reply) {
  const current = get("messages", message.id);
  if (!current?.contact) return null;
  return put("outbox", {
    id: randomUUID(),
    messageId: current.id,
    contact: current.contact,
    message: reply,
    token: current.token,
    status: "pending",
    attempts: 0,
    revision: 0,
    createdAt: new Date().toISOString(),
  });
}
export function retryNotification(id) {
  const job = get("outbox", id);
  if (!job) throw Object.assign(Error("任务不存在"), { status: 404 });
  if (job.status === "sending")
    throw Object.assign(Error("通知正在发送，请等待本次发送完成后再重试。"), {
      status: 409,
      code: "NOTIFICATION_SENDING",
    });
  if (job.status === "cancelled" || !ownerOf(job))
    throw Object.assign(Error("原问答已删除，此通知无法重试。"), {
      status: 409,
      code: "NOTIFICATION_CANCELLED",
    });
  return put("outbox", {
    ...job,
    status: "pending",
    error: "",
    revision: version(job) + 1,
  });
}
async function providerSend(job, config, link) {
  if (process.env.TEST_MODE) throw Error("隔离测试禁止使用真实通知提供商");
  if (job.contact.type === "email") {
    if (!config.accountName) throw Error("未设置阿里云邮件发信地址");
    const client = new RPCClient({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: config.mailEndpoint || "https://dm.aliyuncs.com",
      apiVersion: "2015-11-23",
    });
    await client.request(
      "SingleSendMail",
      {
        AccountName: config.accountName,
        AddressType: 1,
        ReplyToAddress: false,
        ToAddress: job.contact.value,
        Subject: "林珈诚 · 你的问答",
        TextBody: `${job.message}\n\n查看完整问答：${link}`,
        FromAlias: "林珈诚",
      },
      { method: "POST" },
    );
  } else {
    if (!config.signName || !config.templateCode)
      throw Error("未设置阿里云短信签名或模板");
    const client = new RPCClient({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: "https://dysmsapi.aliyuncs.com",
      apiVersion: "2017-05-25",
    });
    const vars = { reply: job.message, link };
    const params = Object.fromEntries(
      Object.entries(
        config.templateParams || { reply: "{{reply}}", link: "{{link}}" },
      ).map(([key, value]) => [
        key,
        String(value).replace(/\{\{(reply|link)\}\}/g, (_, name) => vars[name]),
      ]),
    );
    const result = await client.request(
      "SendSms",
      {
        PhoneNumbers: job.contact.value,
        SignName: config.signName,
        TemplateCode: config.templateCode,
        TemplateParam: JSON.stringify(params),
      },
      { method: "POST" },
    );
    if (result.Code !== "OK") throw Error(`${result.Code}: ${result.Message}`);
  }
}
let busy = false;
export async function deliver({ send = providerSend } = {}) {
  if (busy) return;
  busy = true;
  try {
    const config = setting("notifications", {});
    for (const snapshot of list("outbox").filter(
      (job) => job.status === "pending",
    )) {
      const job = get("outbox", snapshot.id);
      if (!job || job.status !== "pending") continue;
      const owner = ownerOf(job);
      if (!owner) {
        put("outbox", cancelled(job));
        continue;
      }
      if (!config.accessKeyId || !config.accessKeySecret) {
        put("outbox", {
          ...job,
          messageId: owner.id,
          status: "unconfigured",
          error: "尚未配置阿里云凭证",
          revision: version(job) + 1,
        });
        continue;
      }
      const attemptId = randomUUID();
      const claimed = {
        ...job,
        messageId: owner.id,
        status: "sending",
        attemptId,
        attempts: (job.attempts || 0) + 1,
        revision: version(job) + 1,
      };
      put("outbox", claimed);
      let outcome;
      try {
        await send(claimed, config, notificationLink(config, claimed.token));
        outcome = {
          status: "sent",
          sentAt: new Date().toISOString(),
          error: "",
        };
      } catch (error) {
        outcome = {
          status: "failed",
          error: String(error.message)
            .replaceAll(config.accessKeySecret || "__none__", "[redacted]")
            .slice(0, 500),
        };
      }
      const latest = get("outbox", job.id);
      // No stale snapshot may resurrect a deleted/cancelled/newer task.
      if (
        !latest ||
        latest.status !== "sending" ||
        latest.attemptId !== attemptId ||
        latest.revision !== claimed.revision ||
        !ownerOf(latest)
      )
        continue;
      const { attemptId: _, ...finished } = latest;
      put("outbox", { ...finished, ...outcome, revision: version(latest) + 1 });
    }
  } finally {
    busy = false;
  }
}
