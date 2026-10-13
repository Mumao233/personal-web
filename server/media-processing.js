import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
export const MAX_MEDIA_FILES = 20;
export const MAX_PREVIEW_BYTES = 30 * 1024 * 1024;
const raster = new Set(["jpeg", "png", "webp", "gif"]);
const extensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"]);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

export async function sanitizeImage(input) {
  try {
    // Re-encoding every frame removes EXIF/IPTC/XMP/GPS while preserving animation.
    const bytes = typeof input === "string" ? await readFile(input) : input;
    const image = sharp(bytes, { animated: true, limitInputPixels: 60_000_000 });
    const metadata = await image.metadata();
    if (!raster.has(metadata.format)) throw failure("仅支持 JPG、PNG、WebP 和 GIF 图片");
    const buffer = await image.rotate().toBuffer();
    return { buffer, extension: metadata.format === "jpeg" ? ".jpg" : `.${metadata.format}` };
  } catch (error) {
    if (error.status) throw error;
    throw failure("图片无法读取或尺寸过大，请重新导出后上传");
  }
}

function originalName(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 240 ||
      /[\u0000-\u001f\u007f\\/:*?"<>|]/.test(name) || name === "." || name === ".." ||
      !extensions.has(extname(name).toLowerCase())) throw failure("上传文件名或文件格式无效");
  return name;
}

export function validMediaBasename(name) {
  return typeof name === "string" && name.length <= 240 && basename(name) === name &&
    /^[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp|gif|pdf)$/i.test(name) && !name.includes("..");
}

function checkBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES)
    throw failure("文件必须为非空字节数据，且每个文件不能超过 15 MiB");
}

export async function prepareMedia(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_MEDIA_FILES)
    throw failure("每次请选择 1 至 20 个文件");
  // Validate the complete envelope before doing expensive image decoding.
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw failure("上传文件参数无效");
    originalName(file.name);
    checkBytes(file.buffer);
  }
  const prepared = [];
  for (const { name, buffer } of files) {
    let clean;
    if (extname(name).toLowerCase() === ".pdf") {
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw failure("PDF 文件内容无效");
      clean = { buffer: Buffer.from(buffer), extension: ".pdf" };
    } else clean = await sanitizeImage(buffer);
    checkBytes(clean.buffer);
    prepared.push({ name, ...clean });
  }
  return prepared;
}

const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
async function checkedDirectory(path, create) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("媒体目录不可用", 400);
  return realpath(path);
}

export async function mediaDirectories(dataDir, { create = false, incoming = false, cacheOptional = false } = {}) {
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) throw failure("媒体数据目录必须为绝对路径");
  const root = resolve(dataDir);
  const realRoot = await checkedDirectory(root, false);
  const result = {};
  for (const name of ["uploads", "media-cache", ...(incoming ? ["media-incoming"] : [])]) {
    const path = resolve(root, name);
    let actual;
    try { actual = await checkedDirectory(path, create); }
    catch (error) {
      if (name !== "media-cache" || !cacheOptional || create || error.code !== "ENOENT") throw error;
      result.cache = path;
      continue;
    }
    if (!samePath(actual, resolve(realRoot, name))) throw failure("媒体目录不能使用符号链接");
    result[name === "uploads" ? "uploads" : name === "media-cache" ? "cache" : "incoming"] = path;
  }
  return result;
}

async function safeRead(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw failure("媒体文件必须是普通文件");
  if (info.size < 1 || info.size > MAX_MEDIA_BYTES) throw failure("媒体文件大小超出限制");
  // O_NOFOLLOW closes the final-component symlink race on supported platforms.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev ||
        current.size < 1 || current.size > MAX_MEDIA_BYTES) throw failure("媒体文件已变化，请重试", 409);
    const buffer = await handle.readFile();
    checkBytes(buffer);
    return { buffer, info: current };
  } finally { await handle.close(); }
}

export function mediaCachePath(cache, name, info) {
  return resolve(cache, createHash("sha256").update(`${name}:${info.size}:${info.mtimeMs}:v1`)
    .digest("hex") + extname(name).toLowerCase());
}

// Publish completed bytes with a no-clobber hard link. A interrupted write never
// exposes a partially written image, and existing files are never overwritten.
async function writeNew(path, buffer) {
  const temporary = path + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close(); handle = null;
    try { await link(temporary, path); return true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await safeRead(path);
      if (!existing.buffer.equals(buffer)) throw failure("媒体请求标识已用于不同的文件", 409);
      return false;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function savePreparedMedia(dataDir, prepared, { operationId } = {}) {
  if (!Array.isArray(prepared) || !prepared.length || prepared.length > MAX_MEDIA_FILES)
    throw failure("媒体保存参数无效");
  if (operationId !== undefined && (typeof operationId !== "string" || !operationId.trim() || operationId.length > 200))
    throw failure("媒体请求标识无效");
  for (const file of prepared) {
    originalName(file?.name); checkBytes(file?.buffer);
    if (![".jpg", ".png", ".webp", ".gif", ".pdf"].includes(file.extension)) throw failure("媒体文件格式无效");
  }
  const { uploads, cache } = await mediaDirectories(dataDir, { create: true });
  const created = [];
  const rollback = async () => {
    for (const path of [...created].reverse()) {
      await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    created.length = 0;
  };
  try {
    const files = [];
    for (const [index, file] of prepared.entries()) {
      const stem = operationId === undefined ? randomUUID() : "assistant-" + createHash("sha256")
        .update(JSON.stringify([operationId, index])).digest("hex");
      const name = stem + file.extension;
      const destination = resolve(uploads, name);
      if (await writeNew(destination, file.buffer)) created.push(destination);
      if (file.extension !== ".pdf") {
        const cleanCopy = mediaCachePath(cache, name, await lstat(destination));
        if (await writeNew(cleanCopy, file.buffer)) created.push(cleanCopy);
      }
      files.push({ url: "/uploads/" + name, name: file.name });
    }
    return { files, rollback };
  } catch (error) { await rollback(); throw error; }
}

const pending = new Map();
export async function sanitizedMediaFile(dataDir, name) {
  if (!validMediaBasename(name)) throw failure("媒体文件名无效");
  const { uploads, cache } = await mediaDirectories(dataDir, { create: true });
  const source = resolve(uploads, name);
  const original = await safeRead(source);
  if (extname(name).toLowerCase() === ".pdf") {
    if (!original.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw failure("PDF 文件内容无效");
    return source;
  }
  const destination = mediaCachePath(cache, name, original.info);
  try { await safeRead(destination); return destination; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!pending.has(destination)) {
    pending.set(destination, (async () => {
      const { buffer } = await sanitizeImage(original.buffer);
      checkBytes(buffer);
      await writeNew(destination, buffer);
      return destination;
    })().finally(() => pending.delete(destination)));
  }
  return pending.get(destination);
}

export async function loadPreviewMedia(dataDir, names) {
  if (!Array.isArray(names) || names.length > 100 || names.some(name => !validMediaBasename(name)))
    throw failure("预览仅接受 uploads 中的文件名，最多 100 个");
  if (!names.length) return [];
  let total = 0;
  const files = [];
  // Preview reads do not create caches or alter source files. Existing clean
  // caches are reused, otherwise sanitize in memory so the operation is read-only.
  const { uploads, cache } = await mediaDirectories(dataDir, { cacheOptional: true });
  for (const name of [...new Set(names)]) {
    const original = await safeRead(resolve(uploads, name));
    let buffer = original.buffer, mime;
    total += buffer.length;
    if (total > MAX_PREVIEW_BYTES) throw failure("预览媒体总大小不能超过 30 MiB");
    if (extname(name).toLowerCase() === ".pdf") {
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw failure("PDF 文件内容无效");
      mime = "application/pdf";
    } else {
      try { ({ buffer } = await safeRead(mediaCachePath(cache, name, original.info))); }
      catch (error) { if (error.code !== "ENOENT") throw error; ({ buffer } = await sanitizeImage(buffer)); }
      checkBytes(buffer);
      total += buffer.length - original.buffer.length;
      if (total > MAX_PREVIEW_BYTES) throw failure("预览媒体总大小不能超过 30 MiB");
      mime = `image/${(await sharp(buffer, { animated: true }).metadata()).format}`;
    }
    files.push({ name, mime, base64: buffer.toString("base64") });
  }
  return files;
}
