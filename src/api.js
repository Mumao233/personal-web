export async function api(path, options = {}) {
  const r = await fetch("/api" + path, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
    body:
      options.body instanceof FormData
        ? options.body
        : options.body
          ? JSON.stringify(options.body)
          : undefined,
  });
  let data;
  try {
    data = await r.json();
  } catch {
    if (r.ok) {
      const error = new Error("服务器返回格式异常，请稍后重试");
      error.status = r.status;
      error.code = "INVALID_RESPONSE";
      throw error;
    }
    data = {};
  }
  if (!r.ok) {
    const error = new Error(data?.error || "操作失败，请稍后重试");
    error.status = r.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}
export const date = (v) =>
  v
    ? new Date(v).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : "";
