const pages = {
  home: ["个人空间", "学习、作品、文字，以及对世界的持续观察。"],
  about: ["关于我", "一些经历、正在关注的事，以及联系我的方式。"],
  projects: ["作品与项目", "做过的事，与正在尝试的可能。"],
  notes: ["随笔", "关于学习、生活，以及那些值得多想一会儿的事。"],
  world: ["关于世界", "用问题靠近世界，用照片留住片刻。"],
  you: ["关于你", "这次，想听听你的答案。"],
  us: ["关于我们", "留下问题，慢慢认识彼此。"],
  admin: ["管理空间", "个人空间内容管理。"],
};
const detailPages = { post: "notes", project: "projects", story: "world" };
const collections = { post: "posts", project: "projects", story: "stories" };

export function resolvePageRoute(input) {
  const query =
    input instanceof URLSearchParams
      ? input
      : new URL(input, "https://mumao.site").searchParams;
  if (query.has("answer"))
    return {
      page: "us",
      type: "answer",
      id: query.get("answer"),
      private: true,
    };
  if (query.has("survey"))
    return { page: "you", type: "survey", id: query.get("survey") };
  const type = Object.keys(detailPages).find((key) => query.has(key));
  if (type)
    return {
      page: detailPages[type],
      type,
      id: query.get(type),
      collection: collections[type],
    };
  const requested = query.get("page") || "home";
  return { page: requested, type: "page", private: requested === "admin" };
}

function cleanText(value, max = 160) {
  return typeof value === "string"
    ? value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
}
function trustedOrigin(value) {
  const parsed = new URL(value);
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("网站公开 origin 配置无效");
  return parsed.origin;
}
function publicImage(value, origin) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/uploads/") ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return "";
  const url = new URL(value, origin);
  return url.origin === origin &&
    /^\/uploads\/[^/]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(url.pathname) &&
    !url.search &&
    !url.hash
    ? url.href
    : "";
}

// Input is the public projection only. Never pass drafts, private answers or a
// raw database record here. Explicit unpublished records are rejected as well.
export function buildPublicPageMetadata({
  url,
  origin = "https://mumao.site",
  publicData = {},
}) {
  const base = trustedOrigin(origin);
  const route = resolvePageRoute(url);
  const name = cleanText(publicData.profile?.name, 60) || "林珈诚";
  const siteName = `${name} · 个人空间`;
  let label = pages[route.page]?.[0] || "页面暂不可用";
  let description =
    pages[route.page]?.[1] ||
    "这篇内容暂时不在这里，可以返回列表看看其他记录。";
  let image = "";
  let noindex = !!route.private || !pages[route.page];
  const canonical = new URL("/", base);
  if (route.page !== "home" && pages[route.page] && !route.private)
    canonical.searchParams.set("page", route.page);
  if (route.type === "answer") {
    label = "你的提问";
    description = "这个链接属于这一次对话。";
  } else if (route.collection || route.type === "survey") {
    const list = publicData[route.collection || "surveys"] || [];
    const item = list.find(
      (entry) =>
        entry.id === route.id &&
        entry.published !== false &&
        entry.private !== true,
    );
    if (item) {
      label = cleanText(item.title, 120) || label;
      description =
        cleanText(item.excerpt || item.description || item.body) || description;
      image = publicImage(item.cover, base);
      canonical.searchParams.set(route.type, route.id);
    } else {
      label = "内容暂不可用";
      description = "这篇内容暂时不在这里，可以返回列表看看其他记录。";
      noindex = true;
    }
  }
  return {
    title:
      route.page === "home" && route.type === "page"
        ? siteName
        : `${label} · ${siteName}`,
    description,
    canonical: canonical.href,
    image,
    siteName,
    noindex,
    type: route.collection ? "article" : "website",
  };
}
