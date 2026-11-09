import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import {
  choosePreloads,
  parseFontFaces,
  rangeContains,
  renderFontFaces,
} from "../scripts/build-fonts.mjs";
import { fontCacheControl } from "../server/static-cache.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const families = ["noto-serif-sc", "instrument-serif"];

test("only woff2 files under /fonts/ are cached for a year", () => {
  const immutable = "public, max-age=31536000, immutable";
  assert.equal(fontCacheControl("/app/public/fonts/a/x.1.woff2"), immutable);
  assert.equal(fontCacheControl("D:\site\public\fonts\a\x.woff2"), immutable);
  assert.equal(fontCacheControl("/app/public/fonts/noto-serif-sc.css"), "");
  assert.equal(fontCacheControl("/app/public/assets/Mono.woff2"), "");
  assert.equal(fontCacheControl("/app/public/images/hero.avif"), "");
});

test("font CSS parsing keeps unicode ranges and rewrites to local files", () => {
  const faces = parseFontFaces(`/* [1] */
@font-face {
  font-family: 'Noto Serif SC';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/x/v1/abc.12.woff2) format('woff2');
  unicode-range: U+4e00-4e10, U+5728;
}`);
  assert.equal(faces[0].file, "abc.12.woff2");
  const css = renderFontFaces(faces, "noto-serif-sc");
  assert.match(css, /url\(\/fonts\/noto-serif-sc\/abc\.12\.woff2\)/);
  assert.match(css, /font-display: swap/);
  assert.match(css, /unicode-range: U\+4e00-4e10, U\+5728/);
  assert.doesNotMatch(css, /gstatic/);
});

test("preload selection covers the most first-screen text with at most two slices", () => {
  const face = (file, unicodeRange) => ({ file, unicodeRange });
  const faces = [
    face("a", "U+41"),
    face("b", "U+42-44"),
    face("c", "U+45"),
    face("d", "U+46"),
  ];
  assert.equal(rangeContains("U+42-44, U+50", 0x43), true);
  assert.equal(rangeContains("U+42-44, U+50", 0x45), false);
  const chosen = choosePreloads(faces, "ABCDE");
  assert.equal(chosen.length, 2);
  assert.equal(chosen[0].file, "b");
});

test("generated fonts are local, sliced, licensed and preloaded sparingly", async () => {
  for (const family of families) {
    const css = await read(`public/fonts/${family}.css`);
    assert.doesNotMatch(css, /googleapis|gstatic/);
    assert.match(css, /font-display: swap/);
    assert.match(css, /unicode-range:/);
    for (const [, path] of css.matchAll(/url\(\/fonts\/([^)]+)\)/g))
      await access(new URL(`../public/fonts/${path}`, import.meta.url));
    assert.match(await read(`public/fonts/${family}/OFL.txt`), /Open Font License/);
  }
  const html = await read("index.html");
  assert.doesNotMatch(html, /googleapis|gstatic/);
  const preloads = html.match(/rel="preload"[^>]+as="font"/g) || [];
  assert.ok(preloads.length >= 1 && preloads.length <= 2);
});
