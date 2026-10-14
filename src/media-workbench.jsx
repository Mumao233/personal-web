import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowDown, Trash, UploadSimple } from "@phosphor-icons/react";
import { uploadMedia } from "./media-upload";
import {
  appendUploadedPhoto,
  moveItem,
  readPhotoMetadata,
  validCoordinates,
} from "./media-workbench-state";
import "./media-workbench.css";

function useUploadQueue({
  mode,
  onComplete,
  onBlockedChange,
  metadataReader = readPhotoMetadata,
  uploader = uploadMedia,
}) {
  const [jobs, setJobs] = useState([]);
  const current = useRef([]),
    callbacks = useRef({ onComplete, onBlockedChange });
  callbacks.current = { onComplete, onBlockedChange };
  const mounted = useRef(true),
    requests = useRef(new Map()),
    queue = useRef(Promise.resolve());
  function change(fn) {
    current.current = fn(current.current);
    if (mounted.current) setJobs(current.current);
  }
  const patch = (id, values) =>
    change((items) =>
      items.map((item) => (item.id === id ? { ...item, ...values } : item)),
    );
  const blocked = jobs.some((job) => job.status !== "done");
  useEffect(() => {
    callbacks.current.onBlockedChange?.(blocked);
  }, [blocked]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of requests.current.values()) request.abort();
      for (const job of current.current)
        if (job.preview) URL.revokeObjectURL(job.preview);
      callbacks.current.onBlockedChange?.(false);
    };
  }, []);
  async function add(files) {
    const batch = crypto.randomUUID();
    const added = [...files].map((file) => {
      const supported =
        mode === "pdf"
          ? /\.pdf$/i.test(file.name) &&
            (!file.type || file.type === "application/pdf")
          : ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
              file.type,
            ) ||
            (!file.type && /\.(jpe?g|png|webp|gif)$/i.test(file.name));
      const error = !supported
        ? mode === "pdf"
          ? "请选择 PDF 文件"
          : "请选择 JPG、PNG、WebP 或 GIF"
        : file.size > 15 * 1024 * 1024
          ? "文件超过15MB，请重新选择"
          : !file.size
            ? "文件为空"
            : "";
      return {
        id: crypto.randomUUID(),
        batch,
        file,
        name: file.name,
        size: file.size,
        status: error ? "error" : mode === "pdf" ? "ready" : "reading",
        percent: 0,
        error,
        invalid: !!error,
        alt: "",
        caption: "",
        takenAt: "",
        version: "",
        date: "",
        preview: mode === "photo" && supported ? URL.createObjectURL(file) : "",
      };
    });
    change((items) => [...items, ...added]);
    await Promise.all(
      added
        .filter((job) => job.status === "reading")
        .map(async (job) => {
          let metadata = {};
          try {
            metadata = (await metadataReader(job.file)) || {};
          } catch {
            /* Missing EXIF does not prevent uploading an otherwise valid image. */
          }
          if (mounted.current) patch(job.id, { ...metadata, status: "ready" });
        }),
    );
  }
  async function run(id) {
    const job = current.current.find((item) => item.id === id);
    if (!mounted.current || !job || job.status !== "queued") return;
    patch(id, { status: "uploading", percent: 0, error: "" });
    try {
      const uploaded = await uploader(
        job.file,
        (percent) => patch(id, { percent }),
        (request) => requests.current.set(id, request),
      );
      const latest = current.current.find((item) => item.id === id);
      if (!mounted.current || !latest) return;
      const batch = current.current.filter((item) => item.batch === job.batch);
      const dates = [
        ...new Set(batch.map((item) => item.takenAt).filter(Boolean)),
      ];
      const sameDate =
        dates.length === 1 && batch.every((item) => item.takenAt === dates[0])
          ? dates[0]
          : "";
      callbacks.current.onComplete(latest, uploaded, { sameDate });
      if (latest.preview) URL.revokeObjectURL(latest.preview);
      patch(id, { status: "done", percent: 100, preview: "", file: null });
    } catch (error) {
      if (mounted.current) patch(id, { status: "error", error: error.message });
    } finally {
      requests.current.delete(id);
    }
  }
  function schedule(id) {
    const job = current.current.find((item) => item.id === id);
    if (!job || job.invalid || !["ready", "error"].includes(job.status)) return;
    patch(id, { status: "queued", error: "" });
    queue.current = queue.current.then(() => run(id)).catch(() => {});
  }
  function remove(id) {
    const job = current.current.find((item) => item.id === id);
    requests.current.get(id)?.abort();
    if (job?.preview) URL.revokeObjectURL(job.preview);
    change((items) => items.filter((item) => item.id !== id));
  }
  return {
    jobs,
    add,
    patch,
    remove,
    retry: schedule,
    start: () =>
      current.current
        .filter((job) => job.status === "ready")
        .forEach((job) => schedule(job.id)),
  };
}

function TextField({ label, value, onChange, type = "text", ...props }) {
  return (
    <label>
      {label}
      <input
        type={type}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </label>
  );
}
function OrderButtons({ index, length, move, remove, name }) {
  return (
    <div className="media-actions">
      <button
        type="button"
        disabled={index === 0}
        aria-label={`${name}上移`}
        onClick={() => move(-1)}
      >
        <ArrowUp />
        上移
      </button>
      <button
        type="button"
        disabled={index === length - 1}
        aria-label={`${name}下移`}
        onClick={() => move(1)}
      >
        <ArrowDown />
        下移
      </button>
      <button type="button" onClick={remove}>
        <Trash />
        移除{name}
      </button>
    </div>
  );
}
function JobStatus({ job, retry, remove }) {
  const status = {
    reading: "正在本机读取拍摄信息",
    ready: "待上传",
    queued: "排队中",
    uploading: `正在上传 ${job.percent}%`,
    done: "上传完成",
    error: "上传失败",
  }[job.status];
  return (
    <>
      <p className={job.error ? "error" : "fine"} role="status">
        {status}
        {job.error ? `：${job.error}` : ""}
      </p>
      {job.status === "uploading" && (
        <progress
          max="100"
          value={job.percent}
          aria-label={`${job.name}上传进度`}
        />
      )}
      <div className="media-actions">
        {job.status === "error" && !job.invalid && (
          <button type="button" onClick={retry}>
            重试上传
          </button>
        )}
        <button type="button" onClick={remove}>
          移除此待上传文件
        </button>
      </div>
    </>
  );
}

export function PhotoWorkbench({
  value,
  onChange,
  onBlockedChange,
  isNew,
  metadataReader,
  uploader,
}) {
  const [error, setError] = useState("");
  const gpsChoice = useRef("");
  const [gpsId, setGpsId] = useState("");
  const queue = useUploadQueue({
    mode: "photo",
    metadataReader,
    uploader,
    onBlockedChange,
    onComplete(job, uploaded, { sameDate }) {
      onChange((previous) =>
        appendUploadedPhoto(previous, job, uploaded.url, {
          sameDate,
          isNew,
          useGps: gpsChoice.current === job.id,
        }),
      );
    },
  });
  const photos = value.photos || [];
  const details = value.photoDetails || [];
  const pending = queue.jobs.filter((job) => job.status !== "done");
  const dateCandidates = [
    ...new Set(
      [
        ...details.map((detail) => detail.takenAt),
        ...pending.map((job) => job.takenAt),
      ].filter(Boolean),
    ),
  ].sort();
  function editPhoto(src, key, entry) {
    onChange((previous) => {
      const current = previous.photoDetails || [];
      const detail = current.find((item) => item.src === src) || {
        src,
        alt: "",
        caption: "",
        takenAt: "",
      };
      return {
        ...previous,
        photoDetails: [
          ...current.filter((item) => item.src !== src),
          { ...detail, [key]: entry },
        ],
      };
    });
  }
  return (
    <section className="media-workbench" aria-label="照片工作台">
      <div className="media-section-title">
        <h2>照片工作台</h2>
        <span>照片只加入当前故事</span>
      </div>
      <p className="fine">
        先在本机查看缩略图与拍摄信息，再上传。每次最多20张，每张15MB；GPS候选不会自动查询地址或改变地点。照片文件公开前会去除EXIF。
      </p>
      <label className="media-select">
        选择照片
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          onChange={(event) => {
            const files = [...event.target.files];
            event.target.value = "";
            if (
              files.length > 20 ||
              photos.length + pending.length + files.length > 200
            ) {
              setError("每次最多20张，故事相册最多200张。");
              return;
            }
            setError("");
            void queue.add(files);
          }}
        />
      </label>
      {error && <p className="error">{error}</p>}
      {pending.length > 0 && (
        <>
          <button
            type="button"
            className="quiet"
            disabled={
              !pending.some((job) => job.status === "ready") ||
              pending.some((job) => job.status === "reading")
            }
            onClick={queue.start}
          >
            <UploadSimple />
            上传已选择的照片
          </button>
          <div className="media-photo-grid">
            {pending.map((job) => (
              <article className="media-card" key={job.id}>
                {job.preview && (
                  <img
                    src={job.preview}
                    alt={job.alt || `${job.name}上传前预览`}
                  />
                )}
                <strong>{job.name}</strong>
                <p className="fine">
                  拍摄日期：{job.takenAt || "未知（不填充今天）"}
                </p>
                {validCoordinates(job.lat, job.lng) && (
                  <label className="check">
                    <input
                      type="radio"
                      name="photo-gps-choice"
                      checked={gpsId === job.id}
                      onChange={() => {
                        gpsChoice.current = job.id;
                        setGpsId(job.id);
                      }}
                    />
                    上传成功后使用这张GPS：{Number(job.lat).toFixed(5)},{" "}
                    {Number(job.lng).toFixed(5)}
                    {validCoordinates(value.lat, value.lng)
                      ? "（将替换当前精确坐标）"
                      : ""}
                  </label>
                )}
                <TextField
                  label="照片替代描述"
                  value={job.alt}
                  onChange={(alt) => queue.patch(job.id, { alt })}
                  maxLength={1000}
                />
                <TextField
                  label="照片图注"
                  value={job.caption}
                  onChange={(caption) => queue.patch(job.id, { caption })}
                  maxLength={2000}
                />
                <JobStatus
                  job={job}
                  retry={() => queue.retry(job.id)}
                  remove={() => {
                    if (gpsChoice.current === job.id) {
                      gpsChoice.current = "";
                      setGpsId("");
                    }
                    queue.remove(job.id);
                  }}
                />
              </article>
            ))}
          </div>
          {gpsId && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                gpsChoice.current = "";
                setGpsId("");
              }}
            >
              不使用任何照片GPS
            </button>
          )}
        </>
      )}
      {dateCandidates.length > 0 && (
        <div className="media-date-candidates">
          <span>拍摄日期候选（选择会改为手动日期）：</span>
          {dateCandidates.map((candidate) => (
            <button
              type="button"
              key={candidate}
              onClick={() =>
                onChange((previous) => ({
                  ...previous,
                  date: candidate,
                  dateMode: "manual",
                }))
              }
            >
              {candidate}
            </button>
          ))}
          {dateCandidates.length > 1 && (
            <p className="fine">照片跨越多个日期，请自行选择故事日期。</p>
          )}
        </div>
      )}
      <div className="media-photo-grid">
        {photos.map((src, index) => {
          const detail = details.find((item) => item.src === src) || {};
          return (
            <article className="media-card" key={src}>
              <img src={src} alt={detail.alt || `照片${index + 1}`} />
              <p className="fine">
                已上传 · 照片 {index + 1}
                {value.cover === src ? " · 当前封面" : ""}
              </p>
              <TextField
                label={`照片${index + 1}替代描述`}
                value={detail.alt}
                onChange={(text) => editPhoto(src, "alt", text)}
                maxLength={1000}
              />
              <TextField
                label={`照片${index + 1}图注`}
                value={detail.caption}
                onChange={(text) => editPhoto(src, "caption", text)}
                maxLength={2000}
              />
              <TextField
                label={`照片${index + 1}拍摄日期`}
                type="date"
                value={detail.takenAt}
                onChange={(text) => editPhoto(src, "takenAt", text)}
              />
              {validCoordinates(detail.lat, detail.lng) && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() =>
                    onChange((previous) => ({
                      ...previous,
                      lat: detail.lat,
                      lng: detail.lng,
                      confirmLocation: false,
                    }))
                  }
                >
                  {validCoordinates(value.lat, value.lng)
                    ? "用这张GPS替换当前精确坐标"
                    : "使用这张照片GPS"}
                  （{Number(detail.lat).toFixed(5)},{" "}
                  {Number(detail.lng).toFixed(5)}）
                </button>
              )}
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  onChange((previous) => ({
                    ...previous,
                    cover: previous.cover === src ? "" : src,
                  }))
                }
              >
                {value.cover === src ? "取消封面" : "设为封面"}
              </button>
              <OrderButtons
                index={index}
                length={photos.length}
                name="照片"
                move={(direction) =>
                  onChange((previous) => ({
                    ...previous,
                    photos: moveItem(previous.photos, index, direction),
                  }))
                }
                remove={() =>
                  onChange((previous) => ({
                    ...previous,
                    photos: previous.photos.filter((photo) => photo !== src),
                    photoDetails: (previous.photoDetails || []).filter(
                      (photo) => photo.src !== src,
                    ),
                    cover: previous.cover === src ? "" : previous.cover,
                  }))
                }
              />
            </article>
          );
        })}
      </div>
      {!photos.length && !pending.length && (
        <p className="fine">尚未添加照片，也可以直接写故事。</p>
      )}
    </section>
  );
}

export function ProjectAttachments({
  value,
  onChange,
  onBlockedChange,
  uploader,
}) {
  const [error, setError] = useState("");
  const queue = useUploadQueue({
    mode: "pdf",
    uploader,
    onBlockedChange,
    onComplete(job, uploaded) {
      onChange((previous) => ({
        ...previous,
        attachments: [
          ...(previous.attachments || []),
          {
            src: uploaded.url,
            name: job.name,
            size: uploaded.size ?? job.size,
            version: job.version || "",
            date: job.date || "",
          },
        ],
      }));
    },
  });
  const attachments = value.attachments || [];
  const pending = queue.jobs.filter((job) => job.status !== "done");
  const changeEntry = (index, patch) =>
    onChange((previous) => ({
      ...previous,
      attachments: previous.attachments.map((attachment, i) =>
        i === index ? { ...attachment, ...patch } : attachment,
      ),
    }));
  return (
    <section className="media-workbench" aria-label="项目PDF附件">
      <div className="media-section-title">
        <h2>项目附件</h2>
        <span>PDF · 每个不超过15MB</span>
      </div>
      <p className="fine">
        附件随草稿保存，发布后才向访客开放。支持多份报告或不同版本；移除附件不会删除服务器文件。
      </p>
      <label>
        选择PDF附件
        <input
          type="file"
          multiple
          accept="application/pdf,.pdf"
          onChange={(event) => {
            const files = [...event.target.files];
            event.target.value = "";
            if (
              files.length > 20 ||
              attachments.length + pending.length + files.length > 20
            ) {
              setError("每个项目最多20个PDF附件。");
              return;
            }
            setError("");
            void queue.add(files);
          }}
        />
      </label>
      {error && <p className="error">{error}</p>}
      {pending.length > 0 && (
        <>
          <button
            type="button"
            className="quiet"
            disabled={!pending.some((job) => job.status === "ready")}
            onClick={queue.start}
          >
            <UploadSimple />
            上传已选择的附件
          </button>
          {pending.map((job) => (
            <article className="media-card attachment-card" key={job.id}>
              <strong>{job.file?.name}</strong>
              <div className="field-grid">
                <TextField
                  label="附件显示名称"
                  value={job.name}
                  onChange={(name) => queue.patch(job.id, { name })}
                  maxLength={240}
                />
                <TextField
                  label="附件版本"
                  value={job.version}
                  onChange={(version) => queue.patch(job.id, { version })}
                  maxLength={100}
                />
                <TextField
                  label="附件日期"
                  type="date"
                  value={job.date}
                  onChange={(date) => queue.patch(job.id, { date })}
                />
              </div>
              <JobStatus
                job={job}
                retry={() => queue.retry(job.id)}
                remove={() => queue.remove(job.id)}
              />
            </article>
          ))}
        </>
      )}
      {attachments.map((attachment, index) => (
        <article className="media-card attachment-card" key={attachment.src}>
          <a href={attachment.src} target="_blank" rel="noopener noreferrer">
            打开PDF · {(attachment.size / 1024 / 1024).toFixed(2)} MB
          </a>
          <div className="field-grid">
            <TextField
              label={`附件${index + 1}显示名称`}
              value={attachment.name}
              onChange={(name) => changeEntry(index, { name })}
              maxLength={240}
            />
            <TextField
              label={`附件${index + 1}版本`}
              value={attachment.version}
              onChange={(version) => changeEntry(index, { version })}
              maxLength={100}
            />
            <TextField
              label={`附件${index + 1}日期`}
              type="date"
              value={attachment.date}
              onChange={(date) => changeEntry(index, { date })}
            />
          </div>
          <OrderButtons
            index={index}
            length={attachments.length}
            name="附件"
            move={(direction) =>
              onChange((previous) => ({
                ...previous,
                attachments: moveItem(previous.attachments, index, direction),
              }))
            }
            remove={() =>
              onChange((previous) => ({
                ...previous,
                attachments: previous.attachments.filter((_, i) => i !== index),
              }))
            }
          />
        </article>
      ))}
    </section>
  );
}
