import React, { useSyncExternalStore } from "react";
import { Sun, Moon } from "@phosphor-icons/react";
import { currentTheme, subscribeTheme, setTheme } from "./theme-state.js";

export function useTheme() {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => "dark");
}

export default function ThemeToggle({ className = "", label = false }) {
  const theme = useTheme();
  const light = theme === "light";
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      aria-label={light ? "切换到深色主题" : "切换到浅色主题"}
      aria-pressed={light}
      title={light ? "切换到深色主题" : "切换到浅色主题"}
      onClick={() => setTheme(light ? "dark" : "light")}
    >
      {light ? <Moon size={20} /> : <Sun size={20} />}
      {label && <span>{light ? "深色主题" : "浅色主题"}</span>}
    </button>
  );
}
