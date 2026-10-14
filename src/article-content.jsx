import React, { useState } from "react";
import { ArrowUpRight } from "@phosphor-icons/react";
import { date } from "./api";
import { contentDateValue } from "../shared/content-date.js";
import MediaViewer, {
  articlePhotos,
  imageKey,
  ProjectAttachments,
} from "./media-viewer.jsx";
import "./article-content.css";

function safeUrl(value, image = false) {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) return "";
  if (/^\/(?!\/)/.test(url) || (!image && /^[?#]/.test(url))) return url;
  try {
    const parsed = new URL(url);
    if (["http:", "https:"].includes(parsed.protocol)) return url;
    if (!image && ["mailto:", "tel:"].includes(parsed.protocol)) return url;
  } catch {
    // Malformed URLs are rendered as plain text, never as navigation targets.
  }
  return "";
}

export function inlineImageSources(content) {
  const sources = new Set();
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "image" && safeUrl(node.attrs?.src, true)) {
      sources.add(imageKey(node.attrs.src));
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  }
  visit(content);
  return sources;
}

function renderNode(node, key, onImage, details) {
  if (!node || typeof node !== "object") return null;
  const children = Array.isArray(node.content)
    ? node.content.map((child, i) =>
        renderNode(child, `${key}-${i}`, onImage, details),
      )
    : null;
  switch (node.type) {
    case "doc":
      return <React.Fragment key={key}>{children}</React.Fragment>;
    case "text": {
      let text = typeof node.text === "string" ? node.text : "";
      for (const [i, mark] of (Array.isArray(node.marks)
        ? node.marks
        : []
      ).entries()) {
        const markKey = `${key}-mark-${i}`;
        if (mark.type === "bold") text = <strong key={markKey}>{text}</strong>;
        else if (mark.type === "italic") text = <em key={markKey}>{text}</em>;
        else if (mark.type === "strike") text = <s key={markKey}>{text}</s>;
        else if (mark.type === "link") {
          const href = safeUrl(mark.attrs?.href);
          if (href)
            text = (
              <a key={markKey} href={href} rel="noopener noreferrer">
                {text}
              </a>
            );
        }
      }
      return <React.Fragment key={key}>{text}</React.Fragment>;
    }
    case "paragraph":
      return <p key={key}>{children?.length ? children : <br />}</p>;
    case "heading":
      return node.attrs?.level === 3 ? (
        <h3 key={key}>{children}</h3>
      ) : (
        <h2 key={key}>{children}</h2>
      );
    case "bulletList":
      return <ul key={key}>{children}</ul>;
    case "orderedList":
      return (
        <ol
          key={key}
          start={
            Number.isInteger(node.attrs?.start) && node.attrs.start > 0
              ? node.attrs.start
              : 1
          }
        >
          {children}
        </ol>
      );
    case "listItem":
      return <li key={key}>{children}</li>;
    case "blockquote":
      return <blockquote key={key}>{children}</blockquote>;
    case "horizontalRule":
      return <hr key={key} />;
    case "hardBreak":
      return <br key={key} />;
    case "image": {
      const attrs = {
        ...(details?.find(
          (photo) => imageKey(photo.src) === imageKey(node.attrs?.src),
        ) || {}),
        ...node.attrs,
      };
      const src = safeUrl(attrs.src, true);
      if (!src) return null;
      const width = [25, 50, 75, 100].includes(Number(attrs.width))
        ? Number(attrs.width)
        : 100;
      const align =
        width < 100 && ["left", "right"].includes(attrs.align)
          ? attrs.align
          : "center";
      return (
        <figure
          key={key}
          className={`rich-image rich-image-${align}`}
          style={{ "--image-width": `${width}%` }}
        >
          <button
            type="button"
            className="photo-open"
            onClick={() => onImage?.(src)}
            aria-label={`查看照片${attrs.alt ? `：${attrs.alt}` : ""}`}
          >
            <img
              src={src}
              alt={typeof attrs.alt === "string" ? attrs.alt : ""}
              title={typeof attrs.title === "string" ? attrs.title : undefined}
              loading="lazy"
            />
          </button>
          {typeof attrs.caption === "string" && attrs.caption && (
            <figcaption>{attrs.caption}</figcaption>
          )}
        </figure>
      );
    }
    default:
      return null;
  }
}

export function RichBody({ content, body = "", onImage, photoDetails }) {
  const hasDocument = content?.type === "doc" && Array.isArray(content.content);
  return (
    <div className="rich-body">
      {hasDocument
        ? renderNode(content, "doc", onImage, photoDetails)
        : String(body || "")
            .split(/\r?\n\s*\r?\n/)
            .filter(Boolean)
            .map((paragraph, i) => <p key={i}>{paragraph}</p>)}
    </div>
  );
}

export default function ArticleContent({ item, preview = false, kind }) {
  const [viewing, setViewing] = useState(null);
  if (!item) return null;
  const images = articlePhotos(item);
  const openImage = (src) => {
    const index = images.findIndex(
      (image) => imageKey(image.src) === imageKey(src),
    );
    if (index >= 0) setViewing(index);
  };
  const inline = inlineImageSources(item.content);
  const cover = safeUrl(item.cover, true);
  const showCover = cover && !inline.has(imageKey(cover));
  const displayed = new Set(inline);
  if (showCover) displayed.add(imageKey(cover));
  const photos = (Array.isArray(item.photos) ? item.photos : []).filter(
    (photo) => {
      if (!safeUrl(photo, true) || displayed.has(imageKey(photo))) return false;
      displayed.add(imageKey(photo));
      return true;
    },
  );
  const link = safeUrl(item.link);
  const dateValue = contentDateValue(
    item,
    kind || (Array.isArray(item.photos) ? "stories" : "posts"),
  );
  const publishedDate = date(dateValue);
  const place = item.location || item.city;
  return (
    <article className={`article-content${preview ? " article-preview" : ""}`}>
      <header className="article-heading">
        {(item.category || place || publishedDate) && (
          <div className="article-meta">
            {item.category && <span>{item.category}</span>}
            {place && <span>{place}</span>}
            {publishedDate && <time dateTime={dateValue}>{publishedDate}</time>}
          </div>
        )}
        <h1>{item.title || "未命名文章"}</h1>
        {item.excerpt && <p className="article-excerpt">{item.excerpt}</p>}
      </header>
      {showCover && (
        <button
          type="button"
          className="photo-open article-cover-open"
          onClick={() => openImage(cover)}
          aria-label={`查看封面：${item.title || "文章封面"}`}
        >
          <img
            className="article-cover"
            src={cover}
            alt={
              images.find((image) => imageKey(image.src) === imageKey(cover))
                ?.alt ||
              item.title ||
              "文章封面"
            }
          />
        </button>
      )}
      <RichBody
        content={item.content}
        body={item.body}
        onImage={openImage}
        photoDetails={item.photoDetails}
      />
      {photos.length > 0 && (
        <section className="article-gallery" aria-label="照片相册">
          <h2>镜头里的片刻</h2>
          <div className="photo-grid">
            {photos.map((photo, i) => (
              <figure key={photo}>
                <button
                  type="button"
                  className="photo-open"
                  onClick={() => openImage(photo)}
                  aria-label={`查看照片 ${i + 1}`}
                >
                  <img
                    src={photo}
                    alt={
                      images.find(
                        (image) => imageKey(image.src) === imageKey(photo),
                      )?.alt || `${item.title || "照片故事"} · ${i + 1}`
                    }
                    loading="lazy"
                  />
                </button>
                {images.find((image) => imageKey(image.src) === imageKey(photo))
                  ?.caption && (
                  <figcaption>
                    {
                      images.find(
                        (image) => imageKey(image.src) === imageKey(photo),
                      ).caption
                    }
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        </section>
      )}
      {(kind === "project" ||
        kind === "projects" ||
        (!kind && item.attachments)) && (
        <ProjectAttachments attachments={item.attachments} />
      )}
      {viewing !== null && (
        <MediaViewer
          images={images}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
      {link && (
        <a
          className="text-link article-project-link"
          href={link}
          target="_blank"
          rel="noopener noreferrer"
        >
          查看项目 <ArrowUpRight />
        </a>
      )}
    </article>
  );
}
