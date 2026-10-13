// Rich articles remain structured data. No HTML from an editor is stored or rendered.
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

export function editableContent(input, base = {}) {
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
    if (value !== undefined && value !== "" && value !== null) {
      if (
        !["number", "string"].includes(typeof value) ||
        !Number.isFinite(Number(value))
      )
        fail("地点坐标无效");
      result[key] = Number(value);
    }
  }
  if (own(input, "confirmLocation") || own(base, "confirmLocation"))
    result.confirmLocation =
      (own(input, "confirmLocation")
        ? input.confirmLocation
        : base.confirmLocation) === true;
  const photos = own(input, "photos") ? input.photos : base.photos;
  if (photos !== undefined) {
    if (!Array.isArray(photos) || photos.length > 200)
      fail("相册照片格式无效或超过200张");
    result.photos = photos.map((photo) => string(photo, 2000, "相册图片"));
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
    if (
      !Number.isFinite(content.lat) ||
      Math.abs(content.lat) > 90 ||
      !Number.isFinite(content.lng) ||
      Math.abs(content.lng) > 180
    )
      fail("发布前请选择有效的地点坐标");
    if (requireLocationConfirmation && !content.confirmLocation)
      fail("发布前请确认这个精确位置可以公开");
  }
}

export const contentRevision = (record) =>
  Number.isSafeInteger(record?.revision) ? record.revision : 0;
export function checkRevision(record, revision) {
  if (!Number.isSafeInteger(revision) || revision !== contentRevision(record))
    fail("文章已在其他窗口更新，请重新打开后再保存，当前内容未被覆盖", 409);
}
export function publicContent(record) {
  const { draft, revision, draftSavedAt, confirmLocation, ...live } = record;
  return live;
}
