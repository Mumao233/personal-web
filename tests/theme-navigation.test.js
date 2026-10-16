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
    new URL("../src/navigation.css", import.meta.url),
    "utf8",
  );
  const jsx = await readFile(
    new URL("../src/main.jsx", import.meta.url),
    "utf8",
  );
  assert.match(css, /width:\s*80vw/);
  assert.match(css, /overscroll-behavior-y:\s*contain/);
  assert.match(css, /300ms ease-out/);
  assert.match(css, /180ms ease-out/);
  assert.match(css, /80ms.*!important/);
  assert.match(css, /touch-action:\s*pan-y/);
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
test("mobile frosting feathers its whole surface separately from opaque scrolling text", async () => {
  const css = await readFile(
    new URL("../src/navigation.css", import.meta.url),
    "utf8",
  );
  const jsx = await readFile(
    new URL("../src/main.jsx", import.meta.url),
    "utf8",
  );
  const surface = css.match(/  \.mobile-menu-surface \{([^}]+)\}/)?.[1] || "";
  const navigation =
    [...css.matchAll(/  \.mobile-navigation \{([^}]+)\}/g)]
      .map((match) => match[1])
      .find((rule) => rule.includes("background:")) || "";
  assert.match(surface, /pointer-events:\s*none/);
  assert.match(surface, /backdrop-filter:\s*blur\(6px\)/);
  assert.match(surface, /mask-image:\s*linear-gradient/);
  assert.match(surface, /transparent 0/);
  // The feather must become opaque before the narrowest 36px text inset.
  assert.match(surface, /#000 32px/);
  assert.match(navigation, /background:\s*transparent/);
  assert.doesNotMatch(navigation, /backdrop-filter|mask-image/);
  assert.ok(
    jsx.indexOf("className={`mobile-menu-surface") <
      jsx.indexOf('id="mobile-navigation"'),
  );
});
test("frosted surface follows menu motion and has reduced-transparency fallback", async () => {
  const css = await readFile(
    new URL("../src/navigation.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.mobile-menu-surface,\s*\.mobile-navigation\s*\{/);
  assert.match(
    css,
    /\.mobile-menu-surface\.open,\s*\.mobile-navigation\.open\s*\{/,
  );
  const fallback = css.split(
    "@media (prefers-reduced-transparency: reduce)",
  )[1];
  assert.match(fallback, /\.mobile-menu-surface\s*\{/);
  assert.match(fallback, /backdrop-filter:\s*none/);
  assert.match(fallback, /mask-image:\s*none/);
});
