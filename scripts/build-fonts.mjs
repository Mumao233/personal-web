#!/usr/bin/env node
// Downloads the self-hosted web fonts and regenerates their @font-face CSS.
// Run by hand when a font should be refreshed: `node scripts/build-fonts.mjs`.
// Google Fonts is only contacted here; visitors load every file from this site.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fontsRoot = join(root, "public", "fonts");
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const css2 = "https://fonts.googleapis.com/css2";
const oflBase = "https://raw.githubusercontent.com/google/fonts/main/ofl";

// Text that is visible in the first viewport and set in Noto Serif SC.
const firstScreenText = "在技术与价值之间。林珈诚";
const maxPreloads = 2;

const families = [
  {
    dir: "noto-serif-sc",
    query: "family=Noto+Serif+SC:wght@400..700&display=swap",
    license: `${oflBase}/notoserifsc/OFL.txt`,
    preloadText: firstScreenText,
  },
  {
    dir: "instrument-serif",
    query: "family=Instrument+Serif:ital@0;1&display=swap",
    license: `${oflBase}/instrumentserif/OFL.txt`,
  },
];

async function fetchWithRetry(url, options, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (attempt >= attempts)
        throw new Error(`下载失败：${url}（${error.message}）`);
      await new Promise((done) => setTimeout(done, attempt * 800));
    }
  }
}

export function parseFontFaces(css) {
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
    const value = (name) =>
      body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim() || "";
    const url = body.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    if (!url) throw new Error("font-face 中没有 woff2 地址");
    return {
      family: value("font-family"),
      style: value("font-style"),
      weight: value("font-weight"),
      unicodeRange: value("unicode-range"),
      url,
      file: basename(new URL(url).pathname),
    };
  });
}

export function renderFontFaces(faces, dir) {
  return faces
    .map(
      (face) => `@font-face {
  font-family: ${face.family};
  font-style: ${face.style};
  font-weight: ${face.weight};
  font-display: swap;
  src: url(/fonts/${dir}/${face.file}) format('woff2');
  unicode-range: ${face.unicodeRange};
}
`,
    )
    .join("");
}

export function rangeContains(unicodeRange, codePoint) {
  return unicodeRange.split(",").some((part) => {
    const [start, end] = part
      .trim()
      .replace(/^U\+/i, "")
      .split("-")
      .map((hex) => parseInt(hex, 16));
    return codePoint >= start && codePoint <= (end ?? start);
  });
}

// Greedy cover: the first screen spans several slices, only the best are preloaded.
export function choosePreloads(faces, text, limit = maxPreloads) {
  const remaining = new Set([...text].map((char) => char.codePointAt(0)));
  const chosen = [];
  while (chosen.length < limit && remaining.size) {
    let best = null;
    let bestHits = [];
    for (const face of faces) {
      if (chosen.includes(face)) continue;
      const hits = [...remaining].filter((point) =>
        rangeContains(face.unicodeRange, point),
      );
      if (hits.length > bestHits.length) {
        best = face;
        bestHits = hits;
      }
    }
    if (!best) break;
    chosen.push(best);
    bestHits.forEach((point) => remaining.delete(point));
  }
  return chosen;
}

async function mapLimited(items, limit, task) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (queue.length) await task(queue.shift());
    }),
  );
}

async function buildFamily(family) {
  const target = join(fontsRoot, family.dir);
  await mkdir(target, { recursive: true });
  const css = await (
    await fetchWithRetry(`${css2}?${family.query}`, {
      headers: { "User-Agent": userAgent },
    })
  ).text();
  const faces = parseFontFaces(css);
  if (!faces.length) throw new Error(`${family.dir} 没有返回任何字体切片`);
  await mapLimited(faces, 8, async (face) => {
    const bytes = Buffer.from(
      await (await fetchWithRetry(face.url)).arrayBuffer(),
    );
    if (bytes.subarray(0, 4).toString("latin1") !== "wOF2")
      throw new Error(`${face.file} 不是有效的 woff2 文件`);
    await writeFile(join(target, face.file), bytes);
  });
  const keep = new Set(faces.map((face) => face.file));
  for (const name of await readdir(target))
    if (name.endsWith(".woff2") && !keep.has(name))
      await rm(join(target, name));
  await writeFile(
    join(target, "OFL.txt"),
    Buffer.from(await (await fetchWithRetry(family.license)).arrayBuffer()),
  );
  await writeFile(
    join(fontsRoot, `${family.dir}.css`),
    renderFontFaces(faces, family.dir),
  );
  console.log(`${family.dir}: ${faces.length} 个切片`);
  return family.preloadText
    ? choosePreloads(faces, family.preloadText).map(
        (face) => `/fonts/${family.dir}/${face.file}`,
      )
    : [];
}

async function updateIndexPreloads(hrefs) {
  const path = join(root, "index.html");
  const html = await readFile(path, "utf8");
  const block = hrefs
    .map(
      (href) =>
        `    <link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin />`,
    )
    .join("\n");
  const marker =
    /<!-- font-preloads:start -->[\s\S]*?<!-- font-preloads:end -->/;
  if (!marker.test(html))
    throw new Error("index.html 缺少 font-preloads 标记");
  await writeFile(
    path,
    html.replace(
      marker,
      `<!-- font-preloads:start -->\n${block}\n    <!-- font-preloads:end -->`,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const preloads = [];
  for (const family of families) preloads.push(...(await buildFamily(family)));
  await updateIndexPreloads(preloads);
  console.log(`预加载：\n${preloads.join("\n")}`);
}
