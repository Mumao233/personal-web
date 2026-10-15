export const THEME_STORAGE_KEY = "personal-space-theme";
export const THEME_EVENT = "personal-space-theme-change";

export const normalizeTheme = (value) => (value === "light" ? "light" : "dark");

export function readTheme(storage) {
  try {
    return normalizeTheme(
      (storage || globalThis.localStorage)?.getItem(THEME_STORAGE_KEY),
    );
  } catch {
    return "dark";
  }
}

export function applyTheme(theme, target = globalThis.document) {
  const value = normalizeTheme(theme);
  if (!target) return value;
  target.documentElement.dataset.theme = value;
  target.documentElement.style.colorScheme = value;
  target
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", value === "light" ? "#f6f2e9" : "#050505");
  return value;
}

export function setTheme(theme) {
  const value = applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // A blocked/full storage area must not stop this page's manual switch.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
  return value;
}

export function subscribeTheme(listener) {
  const storageChanged = (event) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    applyTheme(readTheme());
    listener();
  };
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", storageChanged);
  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener("storage", storageChanged);
  };
}

export const currentTheme = () =>
  normalizeTheme(document.documentElement.dataset.theme);

export function dismissFromPointer(start, end) {
  return (
    !!start &&
    Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) <= 8
  );
}
