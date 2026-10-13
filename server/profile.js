const builtinFields = [
  ["name", "姓名"],
  ["email", "邮箱"],
  ["phone", "电话"],
  ["wechat", "微信"],
  ["github", "GitHub"],
];
const builtinKeys = new Set(builtinFields.map(([key]) => key));

export function getProfileFields(profile) {
  const fields = Array.isArray(profile.fields)
    ? profile.fields
    : builtinFields.map(([key, label]) => ({
        id: `profile-${key}`,
        key,
        label,
        href: "",
        visible: true,
      }));
  return fields.map((field) => ({
    ...field,
    value: field.key ? profile[field.key] || "" : field.value || "",
  }));
}

export function safeProfileHref(value) {
  if (typeof value !== "string") return "";
  const href = value.trim();
  if (!href || /[\s\\\u0000-\u001f\u007f]/.test(href)) return "";
  if (/^\/(?!\/)/.test(href) || /^#[^#]/.test(href)) return href;
  try {
    const parsed = new URL(href);
    if (["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol))
      return href;
  } catch {}
  return "";
}

export function profileFieldHref(field) {
  if (field.href) return safeProfileHref(field.href);
  if (field.key === "email") return safeProfileHref(`mailto:${field.value}`);
  if (field.key === "phone")
    return safeProfileHref(`tel:${String(field.value).replace(/[ ()-]/g, "")}`);
  if (field.key === "github") return safeProfileHref(field.value);
  return "";
}

export function publicProfile(profile) {
  if (!Array.isArray(profile.fields)) return profile;
  const fields = getProfileFields(profile).filter(
    (field) => field.visible !== false,
  );
  const result = { ...profile, fields };
  for (const [key] of builtinFields) {
    // The site identity remains public; contact fields honor their visibility.
    if (key !== "name" && !fields.some((field) => field.key === key))
      result[key] = "";
  }
  return result;
}

export function normalizeProfile(old, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("个人资料格式无效");
  const result = { ...old, ...input };
  for (const [key] of builtinFields) {
    if (typeof result[key] !== "string" || result[key].length > 500)
      throw Error("资料内容需为文字，每项最多500字");
  }
  if (!result.name.trim()) throw Error("名字不能为空");
  if (result.github && !/^https?:\/\//i.test(safeProfileHref(result.github)))
    throw Error("公开主页链接需要http或https");
  if (input.fields === undefined) return result;
  if (!Array.isArray(input.fields) || input.fields.length > 30)
    throw Error("个人资料最多30个栏目");
  const ids = new Set(),
    keys = new Set();
  result.fields = input.fields.map((field) => {
    if (
      !field ||
      typeof field !== "object" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(field.id || "") ||
      ids.has(field.id)
    )
      throw Error("资料栏目编号无效或重复");
    ids.add(field.id);
    const key = field.key || "";
    if (key && (!builtinKeys.has(key) || keys.has(key)))
      throw Error("内置资料栏目无效或重复");
    if (key) keys.add(key);
    if (
      typeof field.label !== "string" ||
      !field.label.trim() ||
      field.label.length > 60
    )
      throw Error("请填写栏目名称（最多60字）");
    if (!key && (typeof field.value !== "string" || field.value.length > 500))
      throw Error("栏目内容最多500字");
    const href = field.href || "";
    if (
      typeof href !== "string" ||
      href.length > 2000 ||
      (href && !safeProfileHref(href))
    )
      throw Error("栏目链接需使用 http、https、mailto、tel 或站内路径");
    return {
      id: field.id,
      key,
      label: field.label.trim(),
      value: key ? result[key] : field.value,
      href: href.trim(),
      visible: field.visible !== false,
    };
  });
  return result;
}
