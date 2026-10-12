import RPCClient from "@alicloud/pop-core";
import { list, put, setting } from "./store.js";
import { randomUUID } from "node:crypto";
export function normalizeContact(value = "") {
  value = value.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { type: "email", value };
  const digits = value.replace(/[\s-]/g, "").replace(/^\+86/, "");
  if (/^1[3-9]\d{9}$/.test(digits)) return { type: "sms", value: digits };
  return null;
}
export function notify(contact, message, token) {
  if (!contact) return;
  put("outbox", {
    id: randomUUID(),
    contact,
    message,
    token,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
}
let busy = false;
export async function deliver() {
  if (busy) return;
  busy = true;
  try {
    const config = setting("notifications", {});
    for (const job of list("outbox").filter((x) => x.status === "pending")) {
      if (!config.accessKeyId || !config.accessKeySecret) {
        put("outbox", {
          ...job,
          status: "unconfigured",
          error: "尚未配置阿里云凭证",
        });
        continue;
      }
      try {
        const link = `${config.siteUrl || "http://localhost:5173"}/?answer=${job.token}`;
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
          const params = {};
          for (const [key, value] of Object.entries(
            config.templateParams || { reply: "{{reply}}", link: "{{link}}" },
          ))
            params[key] = String(value).replace(
              /\{\{(reply|link)\}\}/g,
              (_, k) => vars[k],
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
          if (result.Code !== "OK")
            throw Error(`${result.Code}: ${result.Message}`);
        }
        put("outbox", {
          ...job,
          status: "sent",
          attempts: job.attempts + 1,
          sentAt: new Date().toISOString(),
          error: "",
        });
      } catch (e) {
        put("outbox", {
          ...job,
          status: "failed",
          attempts: job.attempts + 1,
          error: String(e.message)
            .replaceAll(config.accessKeySecret || "__none__", "[redacted]")
            .slice(0, 500),
        });
      }
    }
  } finally {
    busy = false;
  }
}
