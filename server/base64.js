// Large media must not use a repeated-group regular expression: some engines
// exhaust their regexp stack on a valid 15 MiB file.
export function decodeBase64(value, maxBytes = 15 * 1024 * 1024) {
  const invalid = () => {
    throw Object.assign(new Error("文件 base64 编码无效或超出大小限制"), {
      status: 400,
      code: "INVALID_BASE64",
    });
  };
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    value.length % 4 !== 0
  )
    invalid();
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))) invalid();
  const buffer = Buffer.from(value, "base64");
  if (
    !buffer.length ||
    buffer.length > maxBytes ||
    buffer.toString("base64") !== value
  )
    invalid();
  return buffer;
}
