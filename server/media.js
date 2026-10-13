import multer from "multer";
import sharp from "sharp";
import { randomUUID, createHash } from "node:crypto";
import { resolve, extname } from "node:path";
import { mkdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { dataDir, list, setting } from "./store.js";
import { publicContent } from "./content.js";
import { publicProfile } from "./profile.js";

const uploads = resolve(dataDir, "uploads");
const incoming = resolve(dataDir, "media-incoming");
const cache = resolve(dataDir, "media-cache");
await Promise.all([uploads, incoming, cache].map(path => mkdir(path, { recursive: true })));
const raster = new Set(["jpeg", "png", "webp", "gif"]);
const error400 = message => Object.assign(new Error(message), { status: 400 });

export async function sanitizeImage(input) {
  try {
    // Decode and re-encode every frame; sharp strips EXIF/IPTC/XMP by default,
    // applies orientation, and converts colour to sRGB without retaining GPS.
    // Buffers avoid libvips retaining an animated input's Windows file handle
    // after completion, so incoming originals can be removed before responding.
    const bytes = typeof input === "string" ? await readFile(input) : input;
    const image = sharp(bytes, { animated: true, limitInputPixels: 60_000_000 });
    const metadata = await image.metadata();
    if (!raster.has(metadata.format)) throw error400("仅支持 JPG、PNG、WebP 和 GIF 图片");
    const buffer = await image.rotate().toBuffer();
    return { buffer, extension: metadata.format === "jpeg" ? ".jpg" : `.${metadata.format}` };
  } catch (error) {
    if (error.status) throw error;
    throw error400("图片无法读取或尺寸过大，请重新导出后上传");
  }
}

function references(value, name) {
  if (typeof value === "string") {
    if (value.split(/[?#]/, 1)[0] === `/uploads/${name}`) return true;
    try {
      const url = new URL(value);
      // Trust configured site origins, never a request's client-controlled Host.
      const origins = (process.env.PUBLIC_ORIGINS || "https://mumao.site,http://mumao.site,http://8.138.100.213")
        .split(",").map(origin => new URL(origin.trim()).origin);
      return !url.username && !url.password && origins.includes(url.origin) && url.pathname === `/uploads/${name}`;
    } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => references(item, name));
  if (value && typeof value === "object")
    return Object.values(value).some(item => references(item, name));
  return false;
}

export function isPublicMedia(name) {
  if (references(publicProfile(setting("profile", {})), name)) return true;
  return ["projects", "posts", "stories"].some(kind =>
    list(kind).some(record => record.published && references(publicContent(record), name)),
  );
}

const pending = new Map();
const cachePath = (name, info) => resolve(cache, createHash("sha256")
  .update(`${name}:${info.size}:${info.mtimeMs}:v1`).digest("hex") + extname(name).toLowerCase());
async function sanitizedFile(name) {
  const source = resolve(uploads, name);
  const info = await stat(source);
  if (extname(name).toLowerCase() === ".pdf") return source;
  const destination = cachePath(name, info);
  const key = destination;
  try { await stat(destination); return destination; } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      const { buffer } = await sanitizeImage(source);
      const temporary = destination + "." + randomUUID() + ".tmp";
      await writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
      return destination;
    })().finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: incoming,
    filename: (_req, _file, done) => done(null, randomUUID()),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, done) => done(
    /\.(jpe?g|png|webp|gif|pdf)$/i.test(file.originalname) ? null : error400("不支持此文件格式"),
    true,
  ),
});

export function registerMediaRoutes(app, auth) {
  app.post("/api/admin/upload", auth, upload.array("files", 20), async (req, res, next) => {
    const created = [];
    let response, failure;
    try {
      if (!req.files?.length) throw error400("请选择要上传的文件");
      const files = [];
      for (const file of req.files) {
        let buffer, extension;
        if (extname(file.originalname).toLowerCase() === ".pdf") {
          buffer = await readFile(file.path);
          if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw error400("PDF 文件内容无效");
          extension = ".pdf";
        } else ({ buffer, extension } = await sanitizeImage(file.path));
        const name = randomUUID() + extension;
        const destination = resolve(uploads, name);
        await writeFile(destination, buffer, { flag: "wx", mode: 0o600 });
        created.push(destination);
        if (extension !== ".pdf") {
          const cleanCopy = cachePath(name, await stat(destination));
          await writeFile(cleanCopy, buffer, { flag: "wx", mode: 0o600 });
          created.push(cleanCopy);
        }
        files.push({ url: "/uploads/" + name, name: file.originalname });
      }
      response = { files };
    } catch (error) {
      await Promise.all(created.map(path => unlink(path).catch(() => {})));
      failure = error;
    } finally {
      await Promise.all((req.files || []).map(file => unlink(file.path).catch(() => {})));
    }
    if (failure) next(failure);
    else res.json(response);
  });
  app.use("/uploads", (req, res, next) => {
    // Every request checks current publication references, including cached legacy
    // images. Draft-only, withdrawn and unreferenced assets require a session.
    res.set({
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    });
    const name = req.path.slice(1);
    if (!["GET", "HEAD"].includes(req.method) || !/^[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp|gif|pdf)$/i.test(name) || name.includes(".."))
      return res.status(404).json({ error: "文件不存在" });
    const send = async () => {
      try {
        const path = await sanitizedFile(name);
        // Legacy uploads may have a misleading suffix. Derive MIME from the
        // sanitized bytes, not the old filename, with nosniff still enabled.
        if (extname(name).toLowerCase() === ".pdf") res.type("application/pdf");
        else {
          const { format } = await sharp(path).metadata();
          res.type(`image/${format}`);
        }
        res.sendFile(path, { cacheControl: false, lastModified: false }, error => {
          if (error && !res.headersSent) next(error);
        });
      } catch (error) {
        if (error.code === "ENOENT") return res.status(404).json({ error: "文件不存在" });
        next(error);
      }
    };
    if (isPublicMedia(name)) void send();
    else auth(req, res, () => void send());
  });
}
