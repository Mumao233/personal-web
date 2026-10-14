import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import "./rich-editor.css";
import { uploadMedia } from "./media-upload";

const uploadAnchors = new PluginKey("richImageUploadAnchors");
const UploadAnchors = Extension.create({
  name: "richImageUploadAnchors",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: uploadAnchors,
        state: {
          init: () => new Map(),
          apply(tr, anchors) {
            const next = new Map();
            for (const [id, pos] of anchors)
              next.set(id, tr.mapping.map(pos, 1));
            const change = tr.getMeta(uploadAnchors);
            if (change?.add)
              for (const item of change.add) next.set(item.id, item.pos);
            if (change?.remove) next.delete(change.remove);
            return next;
          },
        },
      }),
    ];
  },
});

const imageWidth = (value) =>
  [25, 50, 75, 100].includes(Number(value)) ? Number(value) : 100;
const imageAlign = (value) =>
  ["left", "right"].includes(value) ? value : "center";

function EditorImage({ node, selected }) {
  const { src, alt, caption } = node.attrs;
  return (
    <NodeViewWrapper
      as="figure"
      className={`rich-editor-image${selected ? " is-selected" : ""}`}
      contentEditable={false}
      data-drag-handle
    >
      <img src={src} alt={alt || ""} draggable={false} />
      {caption && <figcaption>{caption}</figcaption>}
      {selected && (
        <span className="rich-image-selected">已选中图片 · 上方可调整排版</span>
      )}
    </NodeViewWrapper>
  );
}

const ArticleImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-caption") || "",
        renderHTML: (attributes) => ({ "data-caption": attributes.caption }),
      },
      align: {
        default: "center",
        parseHTML: (element) => imageAlign(element.getAttribute("data-align")),
        renderHTML: (attributes) => ({
          "data-align": imageAlign(attributes.align),
        }),
      },
      width: {
        default: 100,
        parseHTML: (element) => imageWidth(element.getAttribute("data-width")),
        renderHTML: (attributes) => ({
          "data-width": imageWidth(attributes.width),
        }),
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(EditorImage, {
      attrs: ({ node }) => ({
        "data-align": imageAlign(node.attrs.align),
        style: `width: ${imageWidth(node.attrs.width)}%`,
      }),
    });
  },
}).configure({ allowBase64: false });

function initialDocument(content, body) {
  if (content?.type === "doc" && Array.isArray(content.content)) return content;
  return {
    type: "doc",
    content: String(body || "")
      .split(/\r?\n/)
      .map((text) => ({
        type: "paragraph",
        ...(text ? { content: [{ type: "text", text }] } : {}),
      })),
  };
}

function uploadImage(file, onProgress, onRequest) {
  return uploadMedia(file, onProgress, onRequest).then((result) => result.url);
}

function ToolButton({ active, children, label, onClick, ...props }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={active ? "is-active" : ""}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
}

const RichEditor = forwardRef(function RichEditor(
  { content, body, onChange, onUploadingChange, photos = [] },
  forwardedRef,
) {
  // A parent key identifies the article. Autosave echoes must not replace the
  // local document, reset undo history, or move a writer's selection.
  const [document] = useState(() => initialDocument(content, body));
  const [, refreshToolbar] = useState(0);
  const [jobs, setJobs] = useState([]);
  const [linkPanel, setLinkPanel] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
  const [albumOpen, setAlbumOpen] = useState(false);
  const callbacks = useRef({ onChange, onUploadingChange });
  callbacks.current = { onChange, onUploadingChange };
  const uploadRef = useRef(null);
  const fileInput = useRef(null);
  const pendingFiles = useRef(new Map());
  const requests = useRef(new Map());
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: false,
        code: false,
        codeBlock: false,
        underline: false,
      }),
      ArticleImage,
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["https", "http", "mailto"],
      }),
      UploadAnchors,
    ],
    content: document,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: "rich-editor-document",
        "aria-label": "图文正文编辑器",
        "data-placeholder": "写下文字，也可以在光标处上传、拖入或粘贴图片…",
      },
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files || []).filter(
          (file) => file.type.startsWith("image/"),
        );
        if (!files.length) return false;
        event.preventDefault();
        uploadRef.current?.(files, view.state.selection.from);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files || []).filter(
          (file) => file.type.startsWith("image/"),
        );
        if (!files.length) return false;
        event.preventDefault();
        const pos =
          view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
          view.state.selection.from;
        uploadRef.current?.(files, pos);
        return true;
      },
    },
    onUpdate({ editor: current }) {
      callbacks.current.onChange?.({
        content: current.getJSON(),
        body: current.getText({ blockSeparator: "\n\n" }),
      });
    },
    onSelectionUpdate() {
      refreshToolbar((version) => version + 1);
    },
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of requests.current.values()) request.abort();
      callbacks.current.onUploadingChange?.(false);
    };
  }, []);

  const blocked = jobs.some((job) =>
    ["queued", "uploading", "error"].includes(job.status),
  );
  useEffect(() => {
    callbacks.current.onUploadingChange?.(blocked);
  }, [blocked]);

  function updateJob(id, patch) {
    if (mounted.current)
      setJobs((current) =>
        current.map((job) => (job.id === id ? { ...job, ...patch } : job)),
      );
  }

  function removeAnchor(id) {
    if (editor && !editor.isDestroyed)
      editor.view.dispatch(
        editor.state.tr.setMeta(uploadAnchors, { remove: id }),
      );
  }

  function insertAt(src, pos) {
    if (!editor || editor.isDestroyed) return false;
    return editor
      .chain()
      .insertContentAt(
        Math.min(Math.max(pos, 0), editor.state.doc.content.size),
        [
          {
            type: "image",
            attrs: {
              src,
              alt: "",
              title: "",
              caption: "",
              align: "center",
              width: 100,
            },
          },
          { type: "paragraph" },
        ],
        { updateSelection: false },
      )
      .run();
  }

  async function runUpload(id) {
    const file = pendingFiles.current.get(id);
    if (!file || !mounted.current || !editor || editor.isDestroyed) return;
    updateJob(id, { status: "uploading", percent: 0, error: "" });
    try {
      const src = await uploadImage(
        file,
        (percent) => updateJob(id, { percent }),
        (request) => requests.current.set(id, request),
      );
      if (!mounted.current || editor.isDestroyed) return;
      const pos = uploadAnchors.getState(editor.state)?.get(id);
      if (pos === undefined || !insertAt(src, pos))
        throw new Error("图片已上传，但插入失败，请重试或重新选择插入位置");
      removeAnchor(id);
      pendingFiles.current.delete(id);
      setJobs((current) => current.filter((job) => job.id !== id));
    } catch (error) {
      updateJob(id, { status: "error", error: error.message });
    } finally {
      requests.current.delete(id);
    }
  }

  function schedule(id) {
    queue.current = queue.current.then(() => runUpload(id)).catch(() => {});
  }

  function addFiles(files, pos = editor?.state.selection.from) {
    if (!editor || editor.isDestroyed) return;
    const added = Array.from(files).map((file) => {
      const id = crypto.randomUUID();
      const supported =
        ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
          file.type,
        ) ||
        (!file.type && /\.(jpe?g|png|webp|gif)$/i.test(file.name));
      const error = !supported
        ? "请选择 JPG、PNG、WebP 或 GIF 图片"
        : file.size > 15 * 1024 * 1024
          ? "图片超过 15 MB，请压缩后重新选择"
          : "";
      if (!error) pendingFiles.current.set(id, file);
      return {
        id,
        name: file.name || "粘贴的图片",
        status: error ? "error" : "queued",
        percent: 0,
        error,
        retryable: !error,
      };
    });
    if (!added.length) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(uploadAnchors, {
        add: added.map(({ id }) => ({ id, pos })),
      }),
    );
    setJobs((current) => [...current, ...added]);
    callbacks.current.onUploadingChange?.(true);
    for (const job of added) if (job.status === "queued") schedule(job.id);
  }
  uploadRef.current = addFiles;

  function insertImage(src) {
    if (!editor || !src) return;
    insertAt(src, editor.state.selection.from);
    editor.commands.focus();
  }
  useImperativeHandle(forwardedRef, () => ({
    insertImage,
    focus: () => editor?.commands.focus(),
  }));

  if (!editor)
    return <p className="rich-editor-loading">正在准备图文编辑器…</p>;

  const selectedImage =
    editor.state.selection instanceof NodeSelection &&
    editor.state.selection.node.type.name === "image";
  const attrs = selectedImage ? editor.state.selection.node.attrs : null;
  const imagePosition = selectedImage ? editor.state.selection.$from : null;
  const imageIndex = imagePosition?.index();
  const canMoveUp = selectedImage && imageIndex > 0;
  const canMoveDown =
    selectedImage && imageIndex < imagePosition.parent.childCount - 1;
  const selectedBlock = editor.isActive("heading", { level: 2 })
    ? "h2"
    : editor.isActive("heading", { level: 3 })
      ? "h3"
      : "p";

  function moveImage(direction) {
    if (!selectedImage) return;
    const { state, view } = editor;
    const { from, node, $from } = state.selection;
    const index = $from.index();
    const neighbor = $from.parent.maybeChild(index + direction);
    if (!neighbor) return;
    const destination =
      direction < 0 ? from - neighbor.nodeSize : from + neighbor.nodeSize;
    const tr = state.tr
      .delete(from, from + node.nodeSize)
      .insert(destination, node);
    tr.setSelection(NodeSelection.create(tr.doc, destination));
    view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  }

  function applyLink() {
    const value = linkValue.trim();
    const href =
      value && !/^[a-z][a-z\d+.-]*:/i.test(value) ? `https://${value}` : value;
    if (href && !/^(https?:\/\/|mailto:)/i.test(href)) {
      setLinkError("请输入 http、https 或 mailto 链接");
      return;
    }
    if (href)
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    else editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setLinkError("");
    setLinkPanel(false);
  }

  return (
    <div className="rich-editor">
      <div
        className="rich-editor-toolbar"
        role="toolbar"
        aria-label="正文排版工具"
      >
        <select
          aria-label="文字样式"
          value={selectedBlock}
          onChange={(event) => {
            const value = event.target.value;
            const command = editor.chain().focus();
            if (value === "p") command.setParagraph().run();
            else command.setHeading({ level: value === "h2" ? 2 : 3 }).run();
          }}
        >
          <option value="p">正文</option>
          <option value="h2">大标题</option>
          <option value="h3">小标题</option>
        </select>
        <ToolButton
          label="加粗"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </ToolButton>
        <ToolButton
          label="斜体"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </ToolButton>
        <span className="rich-toolbar-divider" />
        <ToolButton
          label="无序列表"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          • 列表
        </ToolButton>
        <ToolButton
          label="有序列表"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          1. 列表
        </ToolButton>
        <ToolButton
          label="引用"
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          “ 引用
        </ToolButton>
        <ToolButton
          label="编辑链接"
          active={editor.isActive("link")}
          onClick={() => {
            setLinkValue(editor.getAttributes("link").href || "");
            setLinkError("");
            setLinkPanel(!linkPanel);
          }}
        >
          链接
        </ToolButton>
        <span className="rich-toolbar-divider" />
        <ToolButton
          label="上传并插入图片"
          onClick={() => fileInput.current?.click()}
        >
          ＋ 图片
        </ToolButton>
        {photos.length > 0 && (
          <ToolButton
            label="从相册插入图片"
            active={albumOpen}
            onClick={() => setAlbumOpen(!albumOpen)}
          >
            相册
          </ToolButton>
        )}
        <ToolButton
          label="撤销"
          disabled={!editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
        >
          ↶
        </ToolButton>
        <ToolButton
          label="重做"
          disabled={!editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
        >
          ↷
        </ToolButton>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif"
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {linkPanel && (
        <div className="rich-link-panel">
          <label>
            链接地址
            <input
              autoFocus
              value={linkValue}
              onChange={(event) => setLinkValue(event.target.value)}
              placeholder="https://example.com"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setLinkPanel(false);
                  editor.commands.focus();
                }
              }}
            />
          </label>
          <button type="button" onClick={applyLink}>
            应用
          </button>
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              setLinkPanel(false);
            }}
          >
            移除链接
          </button>
          <button type="button" onClick={() => setLinkPanel(false)}>
            取消
          </button>
          {linkError && <p role="alert">{linkError}</p>}
        </div>
      )}

      {albumOpen && (
        <div className="rich-album-picker" aria-label="相册图片">
          <p>点选图片，插入到当前光标位置。原相册保留。</p>
          <div>
            {photos.map((photo, index) => {
              const src =
                typeof photo === "string" ? photo : photo.url || photo.src;
              return (
                src && (
                  <button
                    type="button"
                    key={`${src}-${index}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertImage(src)}
                    aria-label={`插入相册图片 ${index + 1}`}
                  >
                    <img
                      src={src}
                      alt={`相册图片 ${index + 1}`}
                      loading="lazy"
                    />
                  </button>
                )
              );
            })}
          </div>
        </div>
      )}

      {selectedImage && (
        <div className="rich-image-options" aria-label="图片设置">
          <div className="rich-image-layout">
            <span>图片排版</span>
            {[
              ["center", "独占一行"],
              ["left", "靠左环绕"],
              ["right", "靠右环绕"],
            ].map(([align, label]) => (
              <ToolButton
                key={align}
                label={label}
                active={attrs.align === align}
                onClick={() =>
                  editor
                    .chain()
                    .focus()
                    .updateAttributes("image", {
                      align,
                      width:
                        align !== "center" && attrs.width === 100
                          ? 50
                          : attrs.width,
                    })
                    .run()
                }
              >
                {label}
              </ToolButton>
            ))}
            <label>
              宽度
              <select
                aria-label="图片宽度"
                value={imageWidth(attrs.width)}
                onChange={(event) =>
                  editor.commands.updateAttributes("image", {
                    width: Number(event.target.value),
                  })
                }
              >
                {[25, 50, 75, 100].map((width) => (
                  <option key={width} value={width}>
                    {width}%
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="rich-image-text-fields">
            <label>
              图片说明
              <input
                value={attrs.caption || ""}
                placeholder="显示在图片下方（选填）"
                onChange={(event) =>
                  editor.commands.updateAttributes("image", {
                    caption: event.target.value,
                  })
                }
              />
            </label>
            <label>
              替代文字
              <input
                value={attrs.alt || ""}
                placeholder="简要描述画面，供屏幕阅读器使用"
                onChange={(event) =>
                  editor.commands.updateAttributes("image", {
                    alt: event.target.value,
                  })
                }
              />
            </label>
          </div>
          <div className="rich-image-actions">
            <ToolButton
              label="上移图片"
              disabled={!canMoveUp}
              onClick={() => moveImage(-1)}
            >
              ↑ 上移
            </ToolButton>
            <ToolButton
              label="下移图片"
              disabled={!canMoveDown}
              onClick={() => moveImage(1)}
            >
              ↓ 下移
            </ToolButton>
            <ToolButton
              label="从正文移除图片"
              onClick={() => editor.chain().focus().deleteSelection().run()}
            >
              从正文移除
            </ToolButton>
            <small>
              只移除正文中的图片，不删除相册原图。窄屏自动上下排列。
            </small>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="rich-upload-status" aria-live="polite">
          {jobs.map((job) => (
            <div
              key={job.id}
              className={`rich-upload-job ${job.status === "error" ? "has-error" : ""}`}
            >
              <span className="rich-upload-name">{job.name}</span>
              <span>
                {job.status === "queued"
                  ? "等待上传"
                  : job.status === "uploading"
                    ? `上传 ${job.percent}%`
                    : job.error}
              </span>
              {job.status === "uploading" && (
                <progress
                  value={job.percent}
                  max={100}
                  aria-label={`${job.name} 上传进度`}
                />
              )}
              {job.status === "error" && (
                <>
                  {job.retryable && (
                    <button
                      type="button"
                      onClick={() => {
                        updateJob(job.id, { status: "queued", error: "" });
                        schedule(job.id);
                      }}
                    >
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      pendingFiles.current.delete(job.id);
                      removeAnchor(job.id);
                      setJobs((current) =>
                        current.filter((item) => item.id !== job.id),
                      );
                    }}
                  >
                    放弃此图片
                  </button>
                </>
              )}
            </div>
          ))}
          <p>图片上传完成后才能发布；失败的图片请重试或选择放弃。</p>
        </div>
      )}

      <EditorContent editor={editor} />
      <div className="rich-editor-footnote">
        <span>直接输入文字 · 拖入图片 · 粘贴截图</span>
        <span>图片最大 15 MB · 点击图片调整环绕和图注</span>
      </div>
    </div>
  );
});

export default RichEditor;
