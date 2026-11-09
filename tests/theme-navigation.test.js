import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyTheme,
  readTheme,
  normalizeTheme,
  dismissFromPointer,
  THEME_STORAGE_KEY,
} from "../src/theme-state.js";

test("theme defaults to dark and reads only an explicit valid manual preference", () => {
  assert.equal(readTheme({ getItem: () => null }), "dark");
  assert.equal(readTheme({ getItem: () => "light" }), "light");
  for (const value of ["auto", "system", "LIGHT", "unknown", ""])
    assert.equal(normalizeTheme(value), "dark");
  assert.equal(
    readTheme({
      getItem() {
        throw new Error("storage denied");
      },
    }),
    "dark",
  );
});
test("theme updates root color scheme and browser theme color", () => {
  const root = { dataset: {}, style: {} };
  let color;
  const target = {
    documentElement: root,
    querySelector: () => ({
      setAttribute: (name, value) => {
        if (name === "content") color = value;
      },
    }),
  };
  applyTheme("light", target);
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  assert.equal(color, "#f6f2e9");
  applyTheme("invalid", target);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(color, "#050505");
});
test("exposed-left pointer dismissal accepts taps and rejects swipes/cancelled touches", () => {
  assert.equal(
    dismissFromPointer(
      { clientX: 20, clientY: 300 },
      { clientX: 22, clientY: 304 },
    ),
    true,
  );
  assert.equal(
    dismissFromPointer(
      { clientX: 20, clientY: 700 },
      { clientX: 20, clientY: 320 },
    ),
    false,
  );
  assert.equal(dismissFromPointer(null, { clientX: 20, clientY: 300 }), false);
});
test("manual initialization precedes React and never follows system color preference", async () => {
  const html = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const state = await readFile(
    new URL("../src/theme-state.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    html.indexOf(THEME_STORAGE_KEY) < html.indexOf("/src/bootstrap.jsx"),
  );
  assert.doesNotMatch(html + state, /prefers-color-scheme/);
});
test("navigation confines motion to fixed menu and keeps background scrolling enabled", async () => {
  const css = await readFile(
    new URL("../src/public/base.css", import.meta.url),
    "utf8",
  );
  const jsx = await readFile(
    new URL("../src/site-chrome.jsx", import.meta.url),
    "utf8",
  );
  assert.match(css, /width:\s*80vw/);
  assert.match(css, /overscroll-behavior-y:\s*contain/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(css, /transform var\(--motion-slow\) var\(--ease\)/);
  assert.match(jsx, /createPortal/);
  assert.match(jsx, /dismissFromPointer/);
  assert.match(jsx, /preventScroll:\s*true/);
  assert.doesNotMatch(jsx, /document\.body\.style\.overflow/);
});
test("all CSS media retain their intrinsic colors rather than theme filters", async () => {
  const css = await readFile(
    new URL("../src/navigation.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    css,
    /\bfilter\s*:\s*(?:invert|brightness|hue-rotate|grayscale)/,
  );
  const tokens = await readFile(
    new URL("../src/theme-tokens.css", import.meta.url),
    "utf8",
  );
  assert.match(tokens, /--theme-duration:\s*250ms/);
  assert.match(tokens, /data-theme="light"/);
  assert.match(tokens, /--space-bg:\s*#f6f2e9/);
});
test("public pages use one palette while only admin honors the saved theme", async () => {
  const html = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const admin = html.indexOf('root.dataset.surface = "admin"');
  assert.ok(admin > 0);
  assert.ok(html.indexOf("personal-space-theme") > html.indexOf('page === "admin"'));
  assert.match(html, /data-surface="public"/);
  const main = await readFile(
    new URL("../src/main.jsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(main, /ThemeToggle|theme-tokens|style\.css|space\.css/);
});
test("admin keeps the previous stylesheets in their previous cascade order", async () => {
  const styles = await readFile(
    new URL("../src/admin-styles.js", import.meta.url),
    "utf8",
  );
  const order = [...styles.matchAll(/import "\.\/([^"]+\.css)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(order, [
    "survey-advanced.css",
    "media-viewer.css",
    "article-content.css",
    "profile-fields.css",
    "theme-tokens.css",
    "style.css",
    "space.css",
    "navigation.css",
    "survey-entry.css",
    "nine-grid-project.css",
  ]);
  const admin = await readFile(
    new URL("../src/admin.jsx", import.meta.url),
    "utf8",
  );
  assert.ok(admin.startsWith('import "./admin-styles.js";'));
});
