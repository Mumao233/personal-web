import React, { useEffect, useRef, useState } from "react";
import "./editor-recovery.css";

export function useLeaveGuard({ dirty, blocked, onSave }) {
  const pending = useRef(null);
  const dialogRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const warn = (event) => {
      if (!dirty && !blocked) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, blocked]);
  useEffect(() => () => pending.current?.(false), []);
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, [open]);
  function finish(result) {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(result);
  }
  async function request() {
    if (blocked) return false;
    if (!dirty) return true;
    if (pending.current) return false;
    setOpen(true);
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }
  const dialog = open ? (
    <dialog
      ref={dialogRef}
      className="editor-recovery"
      role="dialog"
      aria-modal="true"
      aria-label="未保存的修改"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) finish(false);
      }}
    >
      <h3>还有未保存的修改</h3>
      <p>可以先保存，也可以放弃本次修改，或继续编辑。</p>
      <div className="publishing-actions">
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              if (await onSave()) finish(true);
              else finish(false);
            } finally {
              setSaving(false);
            }
          }}
        >
          保存并离开
        </button>
        <button type="button" disabled={saving} onClick={() => finish(true)}>
          放弃修改并离开
        </button>
        <button
          type="button"
          autoFocus
          disabled={saving}
          onClick={() => finish(false)}
        >
          继续编辑
        </button>
      </div>
    </dialog>
  ) : null;
  return { request, dialog };
}

export function ConflictRecovery({ value, onReload, onDiscard, busy = false }) {
  const [copy, setCopy] = useState("");
  const [backup, setBackup] = useState(false);
  const serialized = JSON.stringify(value, null, 2);
  return (
    <section className="editor-recovery" role="alert" aria-label="编辑版本冲突">
      <h3>另一个窗口已经更新了这份内容</h3>
      <p>
        当前修改仍留在这里。请先复制备份，再载入最新版继续编辑；旧版本不会覆盖线上内容。
      </p>
      <div className="publishing-actions">
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(serialized);
              setCopy("本地修改已复制");
            } catch {
              setBackup(true);
              setCopy("请选中下方内容复制备份");
            }
          }}
        >
          复制本地修改
        </button>
        <button type="button" disabled={busy} onClick={onReload}>
          放弃本地修改并载入最新版
        </button>
        {onDiscard && (
          <button type="button" disabled={busy} onClick={onDiscard}>
            放弃本地修改并返回列表
          </button>
        )}
      </div>
      {copy && <p role="status">{copy}</p>}
      {backup && (
        <textarea
          aria-label="本地修改备份"
          readOnly
          rows={10}
          value={serialized}
          onFocus={(event) => event.target.select()}
        />
      )}
    </section>
  );
}
