import multer from "multer";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { dataDir, list, setting } from "./store.js";
import { publicContent } from "./content.js";
import { publicProfile } from "./profile.js";
import { mediaDirectories, prepareMedia, savePreparedMedia, sanitizedMediaFile, validMediaBasename } from "./media-processing.js";
export { sanitizeImage } from "./media-processing.js";

const { incoming } = await mediaDirectories(dataDir, { create: true, incoming: true });
const error400 = message => Object.assign(new Error(message), { status: 400 });

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
    list(kind).some(record => record.published && references(publicContent(record, kind), name)),
  );
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
    const rollbacks = [];
    let response, failure;
    try {
      if (!req.files?.length) throw error400("请选择要上传的文件");
      const files = [];
      // Keep only one incoming image in memory at a time on the small ECS host.
      for (const file of req.files) {
        const prepared = await prepareMedia([{ name: file.originalname, buffer: await readFile(file.path) }]);
        const saved = await savePreparedMedia(dataDir, prepared);
        files.push(...saved.files);
        rollbacks.push(saved.rollback);
      }
      response = { files };
    } catch (error) {
      for (const rollback of rollbacks.reverse()) await rollback().catch(() => {});
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
    if (!["GET", "HEAD"].includes(req.method) || !validMediaBasename(name))
      return res.status(404).json({ error: "文件不存在" });
    const send = async () => {
      try {
        const path = await sanitizedMediaFile(dataDir, name);
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
