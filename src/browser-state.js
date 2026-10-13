export function safeStorage(getStorage) {
  const memory = new Map();
  return {
    getItem(key) {
      try {
        const value = getStorage()?.getItem(key);
        if (value != null) { memory.set(key, value); return value; }
      } catch {}
      return memory.get(key) ?? null;
    },
    setItem(key, value) {
      memory.set(key, String(value));
      try { getStorage()?.setItem(key, String(value)); } catch {}
    },
    removeItem(key) {
      memory.delete(key);
      try { getStorage()?.removeItem(key); } catch {}
    },
  };
}
export const sessionState = safeStorage(() => globalThis.sessionStorage);
export function newSubmissionKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}
