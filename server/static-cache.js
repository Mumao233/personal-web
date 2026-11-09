const FONT_FILE = /[\\/]fonts[\\/].+\.woff2$/i;

// Font slice names change with their content. The @font-face CSS keeps a stable
// name and must keep revalidating, so only the woff2 files are immutable.
export function fontCacheControl(path) {
  return FONT_FILE.test(path) ? "public, max-age=31536000, immutable" : "";
}

export function applyFontCache(res, path) {
  const value = fontCacheControl(path);
  if (value) res.setHeader("Cache-Control", value);
}
