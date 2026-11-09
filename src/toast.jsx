import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "@phosphor-icons/react";

export const TOAST_LIMIT = 3;
export const TOAST_SUCCESS_MS = 4000;
const EXIT_MS = 180;

const noop = () => {};
const ToastContext = createContext({ success: noop, error: noop });
export const useToast = () => useContext(ToastContext);

// Newest wins; when full, drop the oldest success before ever dropping an error.
export function trimToasts(items, limit = TOAST_LIMIT) {
  const next = [...items];
  while (next.filter((item) => !item.leaving).length > limit) {
    const live = next.filter((item) => !item.leaving);
    const victim = live.find((item) => item.kind === "success") || live[0];
    next.splice(next.indexOf(victim), 1);
  }
  return next;
}

function ToastItem({ toast, onDismiss }) {
  useEffect(() => {
    if (toast.kind !== "success" || toast.leaving) return undefined;
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, toast.leaving, onDismiss]);
  return (
    <li className={`toast toast-${toast.kind}${toast.leaving ? " is-leaving" : ""}`}>
      <span>{toast.message}</span>
      {toast.kind === "error" && (
        <button
          type="button"
          aria-label="关闭通知"
          onClick={() => onDismiss(toast.id)}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const sequence = useRef(0);
  const timers = useRef(new Set());
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const dismiss = useCallback((id) => {
    setToasts((items) =>
      items.map((item) =>
        item.id === id ? { ...item, leaving: true } : item,
      ),
    );
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((items) => items.filter((item) => item.id !== id));
    }, EXIT_MS);
    timers.current.add(timer);
  }, []);
  const push = useCallback((kind, message) => {
    if (!message) return;
    sequence.current += 1;
    const id = sequence.current;
    setToasts((items) => trimToasts([...items, { id, kind, message }]));
  }, []);
  const value = useMemo(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
    }),
    [push],
  );
  const list = (kind) =>
    toasts
      .filter((toast) => toast.kind === kind)
      .map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ));
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {/* Both live regions stay mounted so that new text is announced. */}
        <ol className="toast-list" aria-live="polite" aria-atomic="false">
          {list("success")}
        </ol>
        <ol className="toast-list" aria-live="assertive" aria-atomic="false">
          {list("error")}
        </ol>
      </div>
    </ToastContext.Provider>
  );
}
