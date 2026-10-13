import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { normalizeDocument } from "../server/content.js";

let vite, ArticleContent, RichBody;
before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "error",
  });
  ({ default: ArticleContent, RichBody } = await vite.ssrLoadModule(
    "/src/article-content.jsx",
  ));
});
after(async () => {
  await vite?.close();
});
const render = (item) =>
  renderToStaticMarkup(React.createElement(ArticleContent, { item }));
const paragraph = (text) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

test("reader preserves legacy paragraphs and treats authored HTML as text", () => {
  const html = render({
    title: "旧文章",
    body: "第一段\n下一行\n\n<script>alert(1)</script>",
    cover: "/uploads/legacy.jpg",
  });
  assert.match(html, /第一段\n下一行/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.equal((html.match(/<p>/g) || []).length, 2);
  assert.match(html, /class="article-cover"/);
});

test("reader consumes validated editor documents without repeating inline, cover or gallery photos", () => {
  const content = normalizeDocument({
    type: "doc",
    content: [
      {
        type: "image",
        attrs: {
          src: "/uploads/cover.jpg",
          width: 50,
          align: "left",
          caption: "海边的光",
        },
      },
      paragraph("环绕图像的正文。"),
      {
        type: "image",
        attrs: { src: "/uploads/story.jpg", width: 75, align: "right" },
      },
      paragraph("另一张照片之后的文字。"),
    ],
  });
  const html = render({
    title: "一个地方",
    content,
    body: "不应重复显示的兼容正文",
    cover: "/uploads/cover.jpg",
    photos: [
      "/uploads/cover.jpg",
      "/uploads/story.jpg",
      "/uploads/remaining.jpg",
      "/uploads/remaining.jpg",
    ],
  });
  assert.equal((html.match(/<img /g) || []).length, 3);
  assert.doesNotMatch(html, /class="article-cover"|不应重复显示的兼容正文/);
  assert.match(html, /rich-image-left/);
  assert.match(html, /rich-image-right/);
  assert.match(html, /--image-width:50%/);
  assert.match(html, /<figcaption>海边的光<\/figcaption>/);
  assert.match(html, /照片相册/);
});

test("reader safely renders formatting and rejects executable navigation even before server validation", () => {
  const html = renderToStaticMarkup(
    React.createElement(RichBody, {
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "安全的强调",
                marks: [{ type: "bold" }, { type: "italic" }],
              },
              {
                type: "text",
                text: "危险链接",
                marks: [
                  { type: "link", attrs: { href: "javascript:alert(1)" } },
                ],
              },
              {
                type: "text",
                text: "正常链接",
                marks: [
                  { type: "link", attrs: { href: "https://example.com/" } },
                ],
              },
            ],
          },
          {
            type: "image",
            attrs: { src: "data:image/svg+xml,<svg onload=alert(1)>" },
          },
          { type: "script", content: [paragraph("不应出现")] },
        ],
      },
    }),
  );
  assert.match(html, /<em><strong>安全的强调<\/strong><\/em>/);
  assert.match(html, /危险链接/);
  assert.match(html, /href="https:\/\/example.com\/"/);
  assert.doesNotMatch(html, /javascript:|data:image|<img|不应出现/);
});

test("a deliberately empty rich document does not resurrect an older body", () => {
  const html = render({
    title: "重新写作",
    content: { type: "doc", content: [{ type: "paragraph" }] },
    body: "已删除的旧正文",
  });
  assert.doesNotMatch(html, /已删除的旧正文/);
  assert.match(html, /<p><br\/><\/p>/);
});
