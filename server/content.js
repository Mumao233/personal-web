// Rich articles remain structured data. No HTML from an editor is stored or rendered.
import { calendarDateAt, isCalendarDate } from "../shared/content-date.js";
const blockTypes = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "horizontalRule",
  "image",
]);
const inlineTypes = new Set(["text", "hardBreak"]);
const simpleMarks = new Set(["bold", "italic", "strike"]);
const editableStrings = {
  title: 300,
  body: 200000,
  cover: 2000,
  link: 2000,
  category: 200,
  status: 300,
  excerpt: 3000,
  date: 40,
  location: 2000,
  city: 300,
  publicLocation: 300,
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function string(value, max, label) {
  if (typeof value !== "string" || value.length > max)
    fail(`${label}格式无效或过长`);
  return value;
}

export function safeArticleLink(value, { mailto = true } = {}) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      ((url.protocol === "https:" || url.protocol === "http:") &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password) ||
      (mailto && url.protocol === "mailto:" && Boolean(url.pathname))
    );
  } catch {
    return false;
  }
}

export function safeArticleImage(value) {
  // Uploaded raster files and the one reviewed, bundled public image. SVG, data,
  // blob, external URLs, encoded paths and path traversal are intentionally absent.
  return (
    typeof value === "string" &&
    value.length <= 2000 &&
    !value.includes("..") &&
    (/^\/uploads\/[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp|gif)$/i.test(value) ||
      value === "/assets/earth.jpg")
  );
}

export function normalizeDocument(document) {
  let count = 0;
  let textLength = 0;
  function visit(node, parent, depth) {
    if (
      !object(node) ||
      typeof node.type !== "string" ||
      depth > 24 ||
      ++count > 10000
    )
      fail("正文结构无效或过于复杂");
    const { type } = node;
    if (
      parent === null
        ? type !== "doc"
        : parent === "paragraph" || parent === "heading"
          ? !inlineTypes.has(type)
          : parent === "bulletList" || parent === "orderedList"
            ? type !== "listItem"
            : !blockTypes.has(type)
    )
      fail("正文包含不支持的节点或排版结构");
    const result = { type };
    if (node.attrs !== undefined && !object(node.attrs))
      fail("正文节点属性无效");
    const attrs = node.attrs || {};
    if (type === "text") {
      result.text = string(node.text, 200000, "正文文字");
      textLength += result.text.length;
      if (!result.text || textLength > 200000) fail("正文文字为空或超过20万字");
    }
    if (inlineTypes.has(type)) {
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks) || node.marks.length > 8)
          fail("文字格式无效");
        result.marks = node.marks.map((mark) => {
          if (!object(mark)) fail("文字格式无效");
          if (simpleMarks.has(mark.type)) return { type: mark.type };
          if (
            mark.type !== "link" ||
            !object(mark.attrs) ||
            !safeArticleLink(mark.attrs.href)
          )
            fail("链接只支持有效的http、https或mailto地址");
          return {
            type: "link",
            attrs: {
              href: mark.attrs.href,
              target: "_blank",
              rel: "noopener noreferrer nofollow",
            },
          };
        });
      }
    } else if (node.marks?.length) fail("此节点不能设置文字格式");
    if (type === "heading") {
      if (![2, 3].includes(attrs.level)) fail("正文标题只支持二级或三级");
      result.attrs = { level: attrs.level };
    }
    if (type === "orderedList") {
      const start = attrs.start ?? 1;
      if (!Number.isInteger(start) || start < 1 || start > 100000)
        fail("列表编号无效");
      result.attrs = { start };
    }
    if (type === "image") {
      if (!safeArticleImage(attrs.src))
        fail("正文图片必须使用本站已上传的图片");
      const align = attrs.align ?? "center";
      const width = attrs.width ?? 100;
      if (
        !["left", "right", "center"].includes(align) ||
        ![25, 50, 75, 100].includes(width)
      )
        fail("图片排版或宽度无效");
      result.attrs = {
        src: attrs.src,
        alt: string(attrs.alt ?? "", 1000, "图片替代文字"),
        title: string(attrs.title ?? "", 1000, "图片标题"),
        caption: string(attrs.caption ?? "", 2000, "图片说明"),
        align,
        width,
      };
    }
    const leaf = ["text", "hardBreak", "horizontalRule", "image"].includes(
      type,
    );
    if (leaf && node.content?.length) fail("正文节点包含无效的子节点");
    if (!leaf) {
      if (node.content !== undefined && !Array.isArray(node.content))
        fail("正文内容格式无效");
      result.content = (node.content || []).map((child) =>
        visit(child, type, depth + 1),
      );
      if (
        (type === "bulletList" || type === "orderedList") &&
        !result.content.length
      )
        fail("列表不能为空");
      if (type === "listItem" && result.content[0]?.type !== "paragraph")
        fail("列表项需要以文字段落开头");
    }
    return result;
  }
  return visit(document, null, 0);
}

export function documentText(document) {
  const walk = (node) => {
    if (node.type === "text") return node.text;
    if (node.type === "hardBreak") return "\n";
    if (node.type === "image")
      return node.attrs?.caption ? `${node.attrs.caption}\n\n` : "";
    const text = (node.content || []).map(walk).join("");
    return ["paragraph", "heading"].includes(node.type) ? `${text}\n\n` : text;
  };
  return walk(document).trim();
}

function calendarDate(value, label) {
  if (value !== "" && !isCalendarDate(value)) fail(`${label}需要有效的YYYY-MM-DD日期`);
  return value;
}
function coordinate(value, key) {
  if (value === "" || value === null) return null;
  if (!["number", "string"].includes(typeof value) ||
      (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value)) ||
      Math.abs(Number(value)) > (key.toLowerCase().includes("lat") ? 90 : 180))
    fail("地点坐标无效或超出范围");
  return Number(value);
}
export function safeArticleAttachment(value) {
  return typeof value === "string" && value.length <= 250 &&
    !value.includes("..") && /^\/uploads\/[a-z0-9][a-z0-9._-]*\.pdf$/i.test(value);
}
function normalizeAttachments(value) {
  if (!Array.isArray(value) || value.length > 20) fail("PDF附件最多20项");
  const seen = new Set();
  return value.map((item) => {
    if (!object(item) || Object.keys(item).some(key => !["src", "name", "size", "version", "date"].includes(key)) ||
        !safeArticleAttachment(item.src) || seen.has(item.src)) fail("附件地址必须是本站PDF且不能重复");
    seen.add(item.src);
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > 15 * 1024 * 1024)
      fail("附件大小无效或超过15 MiB");
    const name = string(item.name, 240, "附件名称").trim();
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) fail("附件名称无效");
    return { src: item.src, name, size: item.size,
      version: string(item.version ?? "", 100, "附件版本"),
      date: calendarDate(item.date ?? "", "附件日期") };
  });
}

export function editableContent(input, base = {}, { kind, isNew = false } = {}) {
  if (!object(input)) fail("文章格式无效");
  const result = {};
  // Only content fields can cross this boundary; IDs, revisions, drafts and
  // publication flags belong to the server-controlled record, never its draft.
  for (const [key, max] of Object.entries(editableStrings)) {
    const source = own(input, key) ? input : base;
    if (own(source, key)) result[key] = string(source[key], max, key);
  }
  for (const key of ["lat", "lng", "cityLat", "cityLng"]) {
    const value = own(input, key) ? input[key] : base[key];
    if (value !== undefined) result[key] = coordinate(value, key);
  }
  if (own(input, "date") && (isNew || input.date !== base.date || base.dateMode !== undefined))
    calendarDate(input.date, "内容日期");
  const explicitDateChange = own(input, "date") && input.date !== base.date;
  const dateMode = own(input, "dateMode") ? input.dateMode :
    explicitDateChange && input.date ? "manual" : base.dateMode ?? (isNew ? "auto" : undefined);
  if (dateMode !== undefined) {
    if (!["auto", "manual"].includes(dateMode)) fail("日期模式无效");
    result.dateMode = dateMode;
  }
  const precision = own(input, "locationPrecision") ? input.locationPrecision :
    base.locationPrecision ?? (kind === "stories" && isNew ? "city" : undefined);
  if (precision !== undefined) {
    if (!["exact", "city", "hidden"].includes(precision)) fail("位置公开精度无效");
    result.locationPrecision = precision;
  }
  if (own(input, "confirmLocation") || own(base, "confirmLocation"))
    result.confirmLocation =
      (own(input, "confirmLocation")
        ? input.confirmLocation
        : base.confirmLocation) === true;
  const publicLocationKeys = precision === "city" ? ["locationPrecision", "cityLat", "cityLng", "publicLocation"] :
    ["locationPrecision", "lat", "lng", "publicLocation"];
  if (input.confirmLocation !== true && publicLocationKeys.some(key => own(input, key) && result[key] !== base[key]))
    result.confirmLocation = false;
  const photos = own(input, "photos") ? input.photos : base.photos;
  if (photos !== undefined) {
    if (!Array.isArray(photos) || photos.length > 200)
      fail("相册照片格式无效或超过200张");
    photos.forEach(photo => string(photo, 2000, "相册图片"));
    // Older versions accepted arbitrary photo URLs. Keep unchanged legacy albums
    // editable; only newly supplied or changed albums must use local media paths.
    const changed = isNew || JSON.stringify(photos) !== JSON.stringify(base.photos);
    if (changed && (new Set(photos).size !== photos.length || photos.some(photo => !safeArticleImage(photo))))
      fail("相册图片必须是本站图片且不能重复");
    result.photos = [...photos];
  }
  const photoDetails = own(input, "photoDetails") ? input.photoDetails : base.photoDetails;
  if (photoDetails !== undefined) {
    if (!Array.isArray(photoDetails) || photoDetails.length > 200) fail("照片资料最多200项");
    const seen = new Set();
    result.photoDetails = photoDetails.map(item => {
      if (!object(item) || Object.keys(item).some(key => !["src", "alt", "caption", "takenAt", "lat", "lng"].includes(key)) ||
          !safeArticleImage(item.src) || seen.has(item.src) || !result.photos?.includes(item.src))
        fail("照片资料必须对应相册内的唯一图片");
      seen.add(item.src);
      const detail = { src: item.src, alt: string(item.alt ?? "", 1000, "图片替代文字"),
        caption: string(item.caption ?? "", 2000, "图片说明"), takenAt: calendarDate(item.takenAt ?? "", "拍摄日期") };
      for (const key of ["lat", "lng"]) if (own(item, key)) detail[key] = coordinate(item[key], key);
      return detail;
    });
  }
  const attachments = own(input, "attachments") ? input.attachments : base.attachments;
  if (attachments !== undefined) {
    if (kind !== "projects") fail("只有项目支持PDF附件");
    result.attachments = normalizeAttachments(attachments);
  }
  const content = own(input, "content") ? input.content : base.content;
  if (own(input, "content") && content === null)
    fail("正文必须是有效的图文文档，清空正文请保留空白文档");
  if (content !== undefined && content !== null) {
    result.content = normalizeDocument(content);
    result.body = documentText(result.content);
  }
  return result;
}

// Auto dates describe the first publication, never draft creation or a guessed
// photo capture date. Existing authored dates remain stable across republishing.
export function publicationContent(kind, content, old = {}, now = new Date().toISOString()) {
  if (kind === "stories" || content.dateMode !== "auto") return content;
  const date = (old.dateMode === "auto" ? old.date : "") || calendarDateAt(old.publishedAt) || old.date ||
    (old.published ? "" : calendarDateAt(now));
  return { ...content, date };
}

export function validatePublication(
  kind,
  content,
  { requireLocationConfirmation = true } = {},
) {
  if (!content.title?.trim()) fail("发布前请填写标题");
  if (
    kind === "projects" &&
    content.link &&
    !safeArticleLink(content.link, { mailto: false })
  )
    fail("项目链接需要有效的http或https地址");
  if (kind === "stories") {
    const precision = content.locationPrecision ?? "exact";
    if (precision === "hidden") return;
    if (precision === "city" && !content.publicLocation?.trim()) fail("发布前请填写公开城市名称");
    const lat = precision === "city" ? content.cityLat : content.lat;
    const lng = precision === "city" ? content.cityLng : content.lng;
    if (
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lng) ||
      Math.abs(lng) > 180
    )
      fail(precision === "city" ? "发布前请选择城市代表坐标" : "发布前请选择有效的地点坐标");
    if (requireLocationConfirmation && !content.confirmLocation)
      fail(precision === "city" ? "发布前请确认城市代表位置可以公开" : "发布前请确认这个精确位置可以公开");
  }
}

export const contentRevision = (record) =>
  Number.isSafeInteger(record?.revision) ? record.revision : 0;
export function checkRevision(record, revision) {
  if (!Number.isSafeInteger(revision) || revision !== contentRevision(record))
    fail("文章已在其他窗口更新，请重新打开后再保存，当前内容未被覆盖", 409);
}
export function publicContent(record, kind) {
  const { draft, revision, draftSavedAt, confirmLocation, ...live } = record;
  if (Array.isArray(live.photoDetails))
    live.photoDetails = live.photoDetails.map(({ src, alt, caption, takenAt }) => ({ src, alt, caption, takenAt }));
  if (kind === "stories" || own(record, "locationPrecision")) {
    const precision = record.locationPrecision ?? "exact";
    delete live.lat; delete live.lng; delete live.cityLat; delete live.cityLng;
    delete live.location; delete live.city;
    const label = record.publicLocation ?? (record.locationPrecision === undefined ? record.location : "");
    if (label) live.location = label;
    if (record.locationPrecision === undefined && record.city) live.city = record.city;
    const lat = precision === "city" ? record.cityLat : record.lat;
    const lng = precision === "city" ? record.cityLng : record.lng;
    if (["exact", "city"].includes(precision) && Number.isFinite(lat) && Number.isFinite(lng)) {
      live.lat = lat; live.lng = lng;
    }
  }
  return live;
}
