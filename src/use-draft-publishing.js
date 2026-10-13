import { useEffect, useRef, useState } from "react";
import { api } from "./api";

// Requests are serialized so an older autosave can never replace newer writing.
export default function useDraftPublishing(kind, item, value, blocked) {
  const enabled = kind !== "surveys";
  const fingerprint = JSON.stringify(value);
  const latest = useRef(value);
  latest.current = value;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const saved = useRef(fingerprint);
  const record = useRef(item);
  const queue = useRef(Promise.resolve());
  const [meta, setMeta] = useState(item);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = fingerprint !== saved.current;

  function serialize(fn) {
    const next = queue.current.catch(() => {}).then(fn);
    queue.current = next;
    return next;
  }
  async function persist(force = false) {
    setSaving(true);
    setError("");
    try {
      while (
        JSON.stringify(latest.current) !== saved.current ||
        (force && record.current.id === "new")
      ) {
        const snapshot = latest.current;
        const snapshotKey = JSON.stringify(snapshot);
        const result = await api(`/admin/${kind}/${record.current.id}/draft`, {
          method: "PUT",
          body: { ...snapshot, revision: record.current.revision || 0 },
        });
        record.current = result;
        saved.current = snapshotKey;
        setMeta(result);
      }
      setMessage("草稿已保存");
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setSaving(false);
    }
  }
  const save = (force = false) => serialize(() => persist(force));
  async function transition(operation) {
    if (blocked) return false;
    setAction(operation);
    setMessage("");
    try {
      await serialize(async () => {
        await persist(true);
        if (blockedRef.current)
          throw new Error("图片尚未处理完成，请完成后再发布。");
        const result = await api(
          `/admin/${kind}/${record.current.id}/${operation}`,
          {
            method: "POST",
            body: { revision: record.current.revision || 0 },
          },
        );
        record.current = result;
        setMeta(result);
      });
      setMessage(
        operation === "publish"
          ? "已发布，访客现在可以阅读这一版。"
          : "已撤下，内容保留在管理空间。",
      );
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setAction("");
    }
  }
  async function leave() {
    if (blocked || action) {
      setError(
        blocked
          ? "图片正在上传或尚未处理完成，请完成后再离开。"
          : "正在发布，请稍候。",
      );
      return false;
    }
    try {
      await save();
      return true;
    } catch {
      return false;
    }
  }
  useEffect(() => {
    if (!enabled || !dirty || blocked || action) return;
    const timer = setTimeout(() => {
      save().catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [fingerprint, enabled, blocked, action]);
  useEffect(() => {
    if (!enabled) return;
    const warn = (event) => {
      if (
        JSON.stringify(latest.current) !== saved.current ||
        blocked ||
        action
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [enabled, blocked, action]);
  return {
    meta,
    dirty,
    saving,
    action,
    error,
    message,
    save,
    leave,
    publish: () => transition("publish"),
    unpublish: () => transition("unpublish"),
  };
}
