import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ArrowLeft, ArrowRight } from "@phosphor-icons/react";
import { formatContentDate } from "../shared/content-date.js";

const FLIP_MS = 280;

export function imageKey(src) {
  try {
    return new URL(src, globalThis.location?.origin || "https://mumao.site")
      .href;
  } catch {
    return src;
  }
}
export function safeMediaUrl(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[\\\u0000- \u007f]/.test(value)
  )
    return "";
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    if (["https:", "http:"].includes(new URL(value).protocol)) return value;
  } catch {}
  return "";
}
export function articlePhotos(item) {
  const images = new Map();
  const details = new Map(
    (Array.isArray(item.photoDetails) ? item.photoDetails : []).map((entry) => [
      imageKey(entry.src),
      entry,
    ]),
  );
  const add = (src, attrs = {}) => {
    if (!safeMediaUrl(src)) return;
    const key = imageKey(src),
      detail = details.get(key) || {};
    const prior = images.get(key);
    const value = {
      src,
      alt: attrs.alt || detail.alt || prior?.alt || item.title || "照片",
      caption: attrs.caption || detail.caption || prior?.caption || "",
      takenAt: detail.takenAt || "",
    };
    images.set(key, value);
  };
  add(item.cover);
  const visit = (node) => {
    if (node?.type === "image") add(node.attrs?.src, node.attrs);
    if (Array.isArray(node?.content)) node.content.forEach(visit);
  };
  visit(item.content);
  (Array.isArray(item.photos) ? item.photos : []).forEach((src) => {
    if (!images.has(imageKey(src))) add(src);
  });
  return [...images.values()];
}

const motionAllowed = (node) =>
  typeof node?.animate === "function" &&
  !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function pageImage(src, dialog) {
  const key = imageKey(src);
  return [...document.querySelectorAll("img")].find(
    (image) =>
      !dialog?.contains(image) &&
      imageKey(image.getAttribute("src")) === key &&
      image.getBoundingClientRect().width > 0,
  );
}

// Where `to` has to start so that it visually sits on top of `from`.
function flipTransform(from, to) {
  const scale = Math.max(from.width / to.width, from.height / to.height);
  const x = from.left + from.width / 2 - (to.left + to.width / 2);
  const y = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

export default function MediaViewer({ images, start = 0, onClose, place = "" }) {
  const [index, setIndex] = useState(start);
  const [failed, setFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [entering, setEntering] = useState(() =>
    motionAllowed(globalThis.document?.documentElement),
  );
  const dialog = useRef(null),
    close = useRef(null),
    stage = useRef(null),
    onCloseRef = useRef(onClose),
    closingRef = useRef(false),
    openedRef = useRef(false),
    currentRef = useRef(null),
    touch = useRef(null);
  onCloseRef.current = onClose;
  const current = images[index];
  currentRef.current = current;
  const move = (step) =>
    setIndex((value) => (value + step + images.length) % images.length);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    const image = stage.current;
    const source =
      currentRef.current && pageImage(currentRef.current.src, dialog.current);
    const target = source?.getBoundingClientRect();
    const visible =
      target && target.bottom > 0 && target.top < globalThis.innerHeight;
    if (!image?.isConnected || !visible || !motionAllowed(image)) {
      onCloseRef.current();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    image
      .animate(
        [
          { transform: "none" },
          { transform: flipTransform(target, image.getBoundingClientRect()) },
        ],
        { duration: FLIP_MS, easing: "ease-out", fill: "forwards" },
      )
      .finished.catch(() => {})
      .finally(() => onCloseRef.current());
  }, []);
  const openFromSource = (image) => {
    if (openedRef.current) return;
    openedRef.current = true;
    setEntering(false);
    const source = pageImage(image.getAttribute("src"), dialog.current);
    if (!source || !motionAllowed(image)) return;
    image.animate(
      [
        {
          transform: flipTransform(
            source.getBoundingClientRect(),
            image.getBoundingClientRect(),
          ),
        },
        { transform: "none" },
      ],
      { duration: FLIP_MS, easing: "ease-out" },
    );
  };
  useEffect(() => setFailed(false), [index]);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const background = [...document.body.children].filter(
      (node) => node !== dialog.current,
    );
    const inert = background.map((node) => [node, node.hasAttribute("inert")]);
    background.forEach((node) => node.setAttribute("inert", ""));
    close.current?.focus();
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        move(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Tab") {
        const focusable = [
          ...dialog.current.querySelectorAll(
            "button:not(:disabled), a[href], [tabindex='0']",
          ),
        ];
        const first = focusable[0],
          last = focusable.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !dialog.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !dialog.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const containFocus = (event) => {
      if (!dialog.current?.contains(event.target)) close.current?.focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = overflow;
      inert.forEach(([node, wasInert]) => {
        if (!wasInert) node.removeAttribute("inert");
      });
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  if (!current) return null;
  const first = Math.max(0, Math.min(index - 3, images.length - 7));
  const taken = formatContentDate(current.takenAt);
  return createPortal(
    <div
      className={`media-viewer${closing ? " is-closing" : ""}${entering ? " is-entering" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="照片查看器"
      ref={dialog}
    >
      <div className="viewer-toolbar">
        <span aria-live="polite" aria-atomic="true">
          照片 {index + 1} / {images.length}
        </span>
        <button
          type="button"
          ref={close}
          onClick={requestClose}
          aria-label="关闭照片查看器"
        >
          <X /> <span>关闭</span>
        </button>
      </div>
      <div
        className="viewer-stage"
        onTouchStart={(event) => {
          touch.current = {
            x: event.changedTouches[0].clientX,
            y: event.changedTouches[0].clientY,
          };
        }}
        onTouchEnd={(event) => {
          if (!touch.current) return;
          const dx = event.changedTouches[0].clientX - touch.current.x,
            dy = event.changedTouches[0].clientY - touch.current.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
            move(dx < 0 ? 1 : -1);
          touch.current = null;
        }}
      >
        <button
          type="button"
          className="viewer-prev"
          disabled={images.length < 2}
          onClick={() => move(-1)}
          aria-label="上一张照片"
        >
          <ArrowLeft />
        </button>
        {failed ? (
          <p role="status">图片暂时无法加载，请尝试切换照片。</p>
        ) : (
          <img
            key={current.src}
            ref={stage}
            src={current.src}
            alt={current.alt}
            onLoad={(event) => openFromSource(event.currentTarget)}
            onError={() => {
              setEntering(false);
              setFailed(true);
            }}
          />
        )}
        <button
          type="button"
          className="viewer-next"
          disabled={images.length < 2}
          onClick={() => move(1)}
          aria-label="下一张照片"
        >
          <ArrowRight />
        </button>
      </div>
      <div className="viewer-caption" aria-live="polite">
        {place && <span className="viewer-place">{place}</span>}
        {taken && <time dateTime={current.takenAt}>{taken}</time>}
        {current.caption && <p>{current.caption}</p>}
      </div>
      <div className="viewer-thumbnails" aria-label="选择照片">
        {images.slice(first, first + 7).map((image, offset) => (
          <button
            type="button"
            key={image.src}
            aria-label={`查看照片 ${first + offset + 1}：${image.alt}`}
            aria-current={index === first + offset ? "true" : undefined}
            onClick={() => setIndex(first + offset)}
          >
            <img src={image.src} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function safePdfSource(value) {
  return typeof value === "string" &&
    /^\/uploads\/[a-z0-9][a-z0-9._-]*\.pdf$/i.test(value) &&
    !value.includes("..")
    ? value
    : "";
}
export function ProjectAttachments({ attachments }) {
  const files = (Array.isArray(attachments) ? attachments : []).filter((file) =>
    safePdfSource(file.src),
  );
  if (!files.length) return null;
  return (
    <section className="project-attachments" aria-label="项目报告与附件">
      <h2>报告与附件</h2>
      {files.map((file) => (
        <div className="project-attachment" key={file.src}>
          <h3>{file.name || "项目报告.pdf"}</h3>
          <p className="attachment-meta">
            {[
              file.version,
              formatContentDate(file.date),
              Number.isFinite(file.size) && file.size > 0
                ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="attachment-actions">
            <a href={file.src} target="_blank" rel="noopener noreferrer">
              预览 PDF（新窗口）
            </a>
            <a href={file.src} download={file.name || "项目报告.pdf"}>
              下载 PDF
            </a>
          </div>
          <p className="attachment-preview-note">
            预览会在新窗口打开浏览器的 PDF 阅读器，也可以下载后阅读。
          </p>
        </div>
      ))}
    </section>
  );
}
