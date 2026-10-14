export { buildPublicPageMetadata } from "../shared/page-info.js";

const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function injectPageMetadata(html, metadata) {
  const tags = [
    `<title>${escape(metadata.title)}</title>`,
    `<meta name="description" content="${escape(metadata.description)}" />`,
    `<link rel="canonical" href="${escape(metadata.canonical)}" />`,
    `<meta property="og:title" content="${escape(metadata.title)}" />`,
    `<meta property="og:description" content="${escape(metadata.description)}" />`,
    `<meta property="og:url" content="${escape(metadata.canonical)}" />`,
    `<meta property="og:type" content="${escape(metadata.type)}" />`,
    `<meta property="og:site_name" content="${escape(metadata.siteName)}" />`,
    `<meta property="og:locale" content="zh_CN" />`,
    ...(metadata.image
      ? [`<meta property="og:image" content="${escape(metadata.image)}" />`]
      : []),
    ...(metadata.noindex
      ? ['<meta name="robots" content="noindex, nofollow" />']
      : []),
  ];
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(
      /<meta\b[^>]*(?:name\s*=\s*["'](?:description|robots)["']|property\s*=\s*["']og:[^"']*["'])[^>]*>/gi,
      "",
    )
    .replace(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/gi, "")
    .replace(/<\/head>/i, `${tags.join("\n")}\n</head>`);
}
