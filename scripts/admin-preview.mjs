import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeBase64 } from "../server/base64.js";
import { publicContent } from "../server/content.js";

const ORIGIN = "https://mumao.site";
const labels = {
  posts: "随笔",
  projects: "作品与项目",
  stories: "照片故事",
  surveys: "问卷",
  profile: "个人资料",
};
const actions = {
  create: "新建草稿",
  update: "修改草稿",
  publish: "发布",
  unpublish: "下架",
};
const mediaName = /^[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|webp|gif|pdf)$/i;
const imageMimes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const maxFileBytes = 15 * 1024 * 1024;
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export function uploadName(value) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return null;
  let path = value;
  if (!value.startsWith("/uploads/")) {
    try {
      const url = new URL(value);
      if (
        ![ORIGIN, "http://mumao.site", "http://8.138.100.213"].includes(
          url.origin,
        ) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const name = path.slice("/uploads/".length);
  return path.startsWith("/uploads/") &&
    mediaName.test(name) &&
    !name.includes("..")
    ? name
    : null;
}

function safeLink(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2000 ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    return "";
  try {
    const url = new URL(value, ORIGIN);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function link(value, label, files) {
  const name = uploadName(value);
  const href = name ? files[name] : safeLink(value);
  if (!href)
    return `<span>${escapeHtml(label || value)}${name ? "（文件未载入）" : ""}</span>`;
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHtml(label || value)}</a>`;
}

function picture(
  source,
  { alt = "", title = "", caption = "", align = "center", width = 100 } = {},
  files = {},
) {
  const name = uploadName(source);
  const local = name && !/\.pdf$/i.test(name) ? files[name] : "";
  const alignment = ["left", "right", "center"].includes(align)
    ? align
    : "center";
  const size = [25, 50, 75, 100].includes(width) ? width : 100;
  const image = local
    ? `<img src="${escapeHtml(local)}" alt="${escapeHtml(alt)}" title="${escapeHtml(title)}">`
    : `<div class="missing-media">${name ? "预览图片未载入" : "外部图片不自动载入"}：${link(source, alt || source, files)}</div>`;
  return `<figure class="image align-${alignment} width-${size}">${image}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
}

export function collectMediaNames(preview) {
  const found = new Set();
  let visited = 0;
  function walk(value, depth = 0) {
    if (depth > 30 || ++visited > 300000) throw new Error("预览结构过于复杂");
    if (typeof value === "string") {
      const name = uploadName(value);
      if (name) found.add(name);
    } else if (Array.isArray(value))
      value.forEach((item) => walk(item, depth + 1));
    else if (value && typeof value === "object")
      Object.values(value).forEach((item) => walk(item, depth + 1));
  }
  for (const item of preview.items || []) {
    walk(item.draft);
    walk(item.live);
  }
  return [...found];
}

function documentHtml(document, files) {
  let count = 0;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 24 || ++count > 10000)
      return "";
    const content = () =>
      (Array.isArray(node.content) ? node.content : [])
        .map((child) => walk(child, depth + 1))
        .join("");
    switch (node.type) {
      case "doc":
        return content();
      case "text": {
        let text = escapeHtml(node.text);
        for (const mark of Array.isArray(node.marks) ? node.marks : []) {
          if (mark.type === "bold") text = `<strong>${text}</strong>`;
          if (mark.type === "italic") text = `<em>${text}</em>`;
          if (mark.type === "strike") text = `<s>${text}</s>`;
          if (mark.type === "link") {
            const name = uploadName(mark.attrs?.href);
            const href = name ? files[name] : safeLink(mark.attrs?.href);
            if (href)
              text = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${text}</a>`;
          }
        }
        return text;
      }
      case "paragraph":
        return `<p>${content() || "<br>"}</p>`;
      case "heading": {
        const level = node.attrs?.level === 3 ? 3 : 2;
        return `<h${level}>${content()}</h${level}>`;
      }
      case "bulletList":
        return `<ul>${content()}</ul>`;
      case "orderedList": {
        const start =
          Number.isSafeInteger(node.attrs?.start) &&
          node.attrs.start > 0 &&
          node.attrs.start <= 100000
            ? node.attrs.start
            : 1;
        return `<ol start="${start}">${content()}</ol>`;
      }
      case "listItem":
        return `<li>${content()}</li>`;
      case "blockquote":
        return `<blockquote>${content()}</blockquote>`;
      case "hardBreak":
        return "<br>";
      case "horizontalRule":
        return "<hr>";
      case "image":
        return picture(node.attrs?.src, node.attrs, files);
      default:
        return "";
    }
  };
  return walk(document);
}

const paragraphs = (text) =>
  String(text ?? "")
    .split(/\n{2,}/)
    .map((value) => `<p>${escapeHtml(value).replace(/\n/g, "<br>")}</p>`)
    .join("");
function article(source, files, kind) {
  const value = publicContent(source, kind);
  const body =
    value.content?.type === "doc"
      ? documentHtml(value.content, files)
      : paragraphs(value.body);
  const inBody = new Set(
    collectMediaNames({ items: [{ draft: value.content }] }),
  );
  const cover = value.cover ? picture(value.cover, { alt: "封面" }, files) : "";
  const photos = (Array.isArray(value.photos) ? value.photos : [])
    .filter((photo) => !inBody.has(uploadName(photo)))
    .map((photo) => {
      const detail = value.photoDetails?.find(item => item.src === photo) || {};
      return picture(photo, { ...detail, caption: [detail.caption, detail.takenAt].filter(Boolean).join(" · ") }, files);
    })
    .join("");
  const details = [
    value.date,
    value.category,
    value.status,
    value.city,
    value.location,
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" · ");
  const attachments = (value.attachments || []).map(item =>
    `<li>${link(item.src, item.name, files)} · ${escapeHtml(item.size)} 字节${item.version ? ` · ${escapeHtml(item.version)}` : ""}${item.date ? ` · ${escapeHtml(item.date)}` : ""}</li>`).join("");
  const privateDetails = kind === "stories" ? `<details class="private-metadata"><summary>后台私有拍摄资料（不会出现在公开阅读页）</summary><p>位置模式：${escapeHtml(source.locationPrecision || "exact（旧记录）")}</p><p>原始地点：${escapeHtml(source.location || "未记录")}；原始坐标：${escapeHtml(source.lat ?? "未知")}, ${escapeHtml(source.lng ?? "未知")}</p>${(source.photoDetails || []).map(item => `<p>${escapeHtml(item.src)}：拍摄坐标 ${escapeHtml(item.lat ?? "未知")}, ${escapeHtml(item.lng ?? "未知")}</p>`).join("")}</details>` : "";
  return `<section class="public-article"><h2>${escapeHtml(value.title || "未命名")}</h2>${details ? `<p class="metadata">${details}</p>` : ""}${!value.date && value.dateMode === "auto" && kind !== "stories" ? '<p class="metadata">日期：首次发布时自动填写上海日期</p>' : ""}${value.excerpt ? `<p class="excerpt">${escapeHtml(value.excerpt)}</p>` : ""}${cover}<div class="body">${body}</div>${value.link ? `<p>项目入口：${link(value.link, value.link, files)}</p>` : ""}${photos ? `<section class="album"><h3>相册</h3>${photos}</section>` : ""}${attachments ? `<section><h3>PDF附件</h3><ul>${attachments}</ul></section>` : ""}${value.lat != null || value.lng != null ? `<p class="metadata">公开位置：${escapeHtml(value.lat)}, ${escapeHtml(value.lng)}</p>` : kind === "stories" ? '<p class="metadata">不公开地图坐标</p>' : ""}</section>${privateDetails}`;
}

function profile(value, files) {
  const fields = Array.isArray(value.fields)
    ? value.fields
    : ["name", "email", "phone", "wechat", "github"].map((key) => ({
        key,
        label: key,
        visible: true,
      }));
  const interests = (value.interests || [])
    .map(
      (item) =>
        `<section><h4>${escapeHtml(item.title)}</h4>${paragraphs(item.text)}<p class="metadata">${escapeHtml(item.status)}</p></section>`,
    )
    .join("");
  const timeline = (value.timeline || [])
    .map(
      (item) =>
        `<section><h4>${escapeHtml(item.date)} · ${escapeHtml(item.title)}</h4>${paragraphs(item.text)}</section>`,
    )
    .join("");
  const unlisted = ["email", "phone", "wechat", "github"]
    .filter((key) => value[key] && !fields.some((field) => field.key === key))
    .map(
      (key) =>
        `<p>${escapeHtml(key)}：${escapeHtml(value[key])}（未列入公开栏目）</p>`,
    )
    .join("");
  return `<h2>${escapeHtml(value.name || "个人资料")}</h2><p class="metadata">姓名作为网站身份始终公开。接受提问：${value.acceptQuestions ? "开启" : "关闭"}</p>${value.portrait ? picture(value.portrait, { alt: "头像", width: 25 }, files) : ""}<dl>${fields.map((field) => `<div class="profile-field${field.visible === false ? " hidden-field" : ""}"><dt>${escapeHtml(field.label)}${field.visible === false ? "（栏目将隐藏）" : ""}</dt><dd>${link(field.href || "", field.key ? value[field.key] : field.value, files)}</dd></div>`).join("")}</dl>${unlisted}${value.intro !== undefined ? `<h3>简介</h3>${paragraphs(value.intro)}` : ""}${value.bio !== undefined ? `<h3>个人自述</h3>${paragraphs(value.bio)}` : ""}${value.interests !== undefined ? `<h3>关注与探索</h3>${interests || "<p>无条目</p>"}` : ""}${value.timeline !== undefined ? `<h3>经历</h3>${timeline || "<p>无条目</p>"}` : ""}`;
}

function survey(value) {
  const typeLabels = {
    single: "单选",
    multiple: "多选",
    rank: "全排序",
    multirank: "部分排序",
    text: "文字",
    matrix: "矩阵",
  };
  const questions = (Array.isArray(value.questions) ? value.questions : [])
    .map((q, index) => {
      const rules = [];
      if (q.condition?.questionId)
        rules.push(
          `显示条件：${q.condition.questionId} 选择「${q.condition.value}」`,
        );
      if (q.min || q.max)
        rules.push(`选择数量：${q.min || 0} 至 ${q.max || "不限"}`);
      if (q.terminateOptions?.length)
        rules.push(`选择后结束：${q.terminateOptions.join("、")}`);
      const exclusive = [
        ...new Set([
          ...(q.exclusiveOptions || []),
          ...(["multiple", "multirank"].includes(q.type) &&
          q.options?.includes("以上都无")
            ? ["以上都无"]
            : []),
        ]),
      ];
      if (exclusive.length) rules.push(`互斥选项：${exclusive.join("、")}`);
      const content =
        q.type === "matrix"
          ? `<div class="table-scroll"><table><thead><tr><th>说法</th>${(q.options || []).map((option) => `<th>${escapeHtml(option)}</th>`).join("")}</tr></thead><tbody>${(q.rows || []).map((row) => `<tr><th scope="row">${escapeHtml(row.title)}</th>${(q.options || []).map(() => "<td>○</td>").join("")}</tr>`).join("")}</tbody></table></div>`
          : q.type === "text"
            ? '<div class="answer-placeholder">文字回答区域（仅预览）</div>'
            : `<ul class="options">${[...(q.options || []), ...(q.allowOther ? ["其他（需填写文字）"] : [])].map((option) => `<li>${q.type === "single" ? "○" : "□"} ${escapeHtml(option)}</li>`).join("")}</ul>`;
      return `<section class="question">${q.section ? `<p class="eyebrow">分组：${escapeHtml(q.section)}</p>` : ""}<h3>${index + 1}. ${escapeHtml(q.title)}</h3>${q.description ? paragraphs(q.description) : ""}<p class="metadata">${escapeHtml(typeLabels[q.type] || q.type)} · ${q.required ? "必答" : "选答"} · 题目 ID：${escapeHtml(q.id)}</p>${content}${rules.map((rule) => `<p class="rule">${escapeHtml(rule)}</p>`).join("")}</section>`;
    })
    .join("");
  return `<h2>${escapeHtml(value.title || "未命名问卷")}</h2>${paragraphs(value.description)}<p class="notice">接收新答卷：${value.closed ? "已关闭" : "开启（仍受发布时间和起止时间限制）"}</p><p class="metadata">时间：${escapeHtml(value.startsAt || "不限")} 至 ${escapeHtml(value.endsAt || "不限")} · 公开结果：${value.publicResults ? "是" : "否"}</p>${questions}<p>提交后提示：${escapeHtml(value.successMessage || "谢谢，你的回答已被保存。")}</p><p>提前结束提示：${escapeHtml(value.terminationMessage || "使用网站默认提示")}</p><p class="notice">本页仅供核对，没有作答或提交入口，不会产生答卷。</p>`;
}

function content(kind, value, files) {
  if (!value || typeof value !== "object")
    return '<p class="metadata">暂无内容</p>';
  return kind === "profile"
    ? profile(value, files)
    : kind === "surveys"
      ? survey(value)
      : article(value, files, kind);
}

export function renderPreview(preview, files = {}) {
  if (
    !preview ||
    !Array.isArray(preview.items) ||
    preview.items.length < 1 ||
    preview.items.length > 20
  )
    throw new Error("预览必须包含1至20项内容");
  const cards = preview.items
    .map((item) => {
      const changes = Array.isArray(item.changes)
        ? item.changes
        : Object.keys(item.changes || {});
      return `<article><header><p class="eyebrow">${escapeHtml(labels[item.kind] || item.kind)} · ${escapeHtml(actions[item.action] || item.action)}</p><p class="metadata">ID：${escapeHtml(item.id || "待创建")} · 版本：${escapeHtml(item.version ?? "新内容")}</p><p>发布目标：${link(item.target || preview.target || "", item.target || preview.target || "仅保存草稿", files)}</p>${changes.length ? `<p>变更字段：${changes.map((change) => escapeHtml(typeof change === "string" ? change : change.field || change.key || JSON.stringify(change))).join("、")}</p>` : ""}${item.stale ? '<p class="notice">线上已更新：需要重新读取并合并后预览。</p>' : ""}${item.action === "unpublish" ? '<p class="notice">本次操作将停止公开展示；问卷同时停止接收新答卷，历史答卷保留。</p>' : ""}</header><div class="candidate">${content(item.kind, item.draft || item.live, files)}</div>${item.live ? `<details><summary>展开核对目前线上内容</summary>${content(item.kind, item.live, files)}</details>` : ""}</article>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><title>本机内容预览 · mumao.site</title><style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#090d12;color:#f1ece3}*{box-sizing:border-box}body{margin:0;line-height:1.8}main{max-width:980px;margin:auto;padding:36px 24px 80px}h1,h2,h3{line-height:1.4}h1{font-size:28px}h2{font-size:25px}h3{font-size:19px}a{color:#a9cef0;overflow-wrap:anywhere}article{background:#111820;border:1px solid #35414e;border-radius:12px;padding:28px;margin:30px 0}article>header{overflow-wrap:anywhere;border-bottom:1px solid #46515d;margin-bottom:26px;padding-bottom:14px}.eyebrow{color:#deb889;font-weight:700}.metadata,figcaption{color:#adbac6;font-size:14px}.notice{border-left:3px solid #deb889;padding:10px 16px;background:#24211e}.body,.candidate,.album{display:flow-root}.body p{white-space:normal;overflow-wrap:anywhere}.excerpt{color:#b7c2cb}.image{max-width:100%;margin:20px 0}.image img{display:block;width:100%;height:auto;border-radius:6px}.image figcaption{text-align:center;margin-top:7px}.align-left{float:left;margin:10px 24px 14px 0}.align-right{float:right;margin:10px 0 14px 24px}.align-center{clear:both;margin-left:auto;margin-right:auto}.width-25{width:25%}.width-50{width:50%}.width-75{width:75%}.width-100{width:100%}.missing-media{border:1px dashed #66727e;padding:20px;overflow-wrap:anywhere}blockquote{border-left:3px solid #c89b6b;margin:18px 0;padding:0 20px;color:#c8d0d8}hr{border:0;border-top:1px solid #44515c}details{clear:both;margin-top:28px;border-top:1px solid #44515c;padding-top:18px}summary{cursor:pointer;color:#c4d8e8}.profile-field{display:grid;grid-template-columns:140px 1fr;gap:16px;margin:12px 0}.profile-field dd{margin:0;overflow-wrap:anywhere}.hidden-field{opacity:.65;text-decoration:line-through}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #44515c;padding:12px;text-align:center}th:first-child{text-align:left;min-width:180px}.question{padding:12px 0;border-bottom:1px solid #35414e}.rule{font-size:14px;color:#dfc29f}.options{list-style:none;padding:0}.answer-placeholder{border:1px dashed #687888;padding:18px;color:#b3bdc8}footer{color:#adbac6;font-size:13px}@media(max-width:640px){main{padding:20px 12px 50px}article{padding:18px}.image{float:none;width:100%;margin:16px 0}.profile-field{grid-template-columns:1fr;gap:2px}}@media print{:root{color-scheme:light;background:#fff;color:#111}article{background:#fff}main{max-width:none}.metadata,figcaption{color:#444}a{color:#234}article{break-inside:avoid}}
</style></head><body><main><h1>发布前核对</h1><p class="notice">这是保存在本机的私有预览，没有公开草稿链接。打开此页不会保存、发布或提交任何内容。</p><p>影响数量：${escapeHtml(preview.impactCount ?? preview.items.length)} 项 · 预览有效期至：${escapeHtml(preview.expiresAt || "见命令返回值")}</p>${cards}<footer>请在聊天中明确指定内容与发布目标后再授权发布。过期或内容版本变化后须重新预览。排版用于核对内容，正式页面沿用网站样式。文件可能包含未发布资料，请勿上传到 Git 或公开目录。</footer></main></body></html>`;
}

export function decodeMediaFile(file, expectedName) {
  if (
    !file ||
    file.name !== expectedName ||
    !mediaName.test(expectedName) ||
    expectedName.includes("..") ||
    ![...imageMimes, "application/pdf"].includes(file.mime)
  )
    throw new Error("预览媒体响应无效");
  const buffer = decodeBase64(file.base64, maxFileBytes);
  const signatures = {
    "image/jpeg":
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    "image/png": buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/gif": /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii")),
    "image/webp":
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP",
    "application/pdf": buffer.subarray(0, 5).toString("ascii") === "%PDF-",
  };
  if (!buffer.length || buffer.length > maxFileBytes || !signatures[file.mime])
    throw new Error("预览媒体类型与内容不符");
  return buffer;
}

export async function createLocalPreview(preview, { directory, fetchMedia }) {
  if (!directory || typeof fetchMedia !== "function")
    throw new Error("需要本机预览目录和媒体读取器");
  const base = resolve(directory);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const destination = join(base, `preview-${randomUUID()}`);
  await mkdir(destination, { mode: 0o700 });
  const files = Object.create(null);
  let total = 0;
  try {
    const names = collectMediaNames(preview);
    if (names.length > 200)
      throw new Error("单次预览最多200个媒体文件，请缩小内容范围");
    for (const name of names) {
      const response = await fetchMedia({ action: "media-get", names: [name] });
      if (!response?.ok || response.files?.length !== 1)
        throw new Error("预览媒体读取失败，尚未生成可发布预览");
      const buffer = decodeMediaFile(response.files[0], name);
      total += buffer.length;
      if (total > 300 * 1024 * 1024)
        throw new Error("单次本机预览媒体总量超过300MiB，请缩小内容范围");
      // Data URLs keep raster media usable in file:// and desktop file viewers.
      // PDFs remain local attachments and are never embedded as active documents.
      if (imageMimes.has(response.files[0].mime))
        files[name] =
          `data:${response.files[0].mime};base64,${buffer.toString("base64")}`;
      else {
        await writeFile(join(destination, name), buffer, {
          flag: "wx",
          mode: 0o600,
        });
        files[name] = `./${name}`;
      }
    }
    const path = join(destination, "index.html");
    await writeFile(path, renderPreview(preview, files), {
      flag: "wx",
      mode: 0o600,
    });
    return { path, mediaCount: names.length, mediaBytes: total };
  } catch (error) {
    // Only this freshly created UUID directory is removed, never the base.
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
