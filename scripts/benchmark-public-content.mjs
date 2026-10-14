// Synthetic records only. Measures payload/serialization costs, not live latency.
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { publicContent } from "../server/content.js";
import { publicSummary } from "../server/public-content.js";
let seed = 29;
const terms = ["观察", "实验", "记录", "城市", "照片", "技术", "作品", "思考", "设计", "旅行", "学习", "生活", "空间", "光线", "材料", "过程"];
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
function sample(id) {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `第${i + 1}段：` + Array.from({ length: 80 }, () => terms[(random() >>> 16) % terms.length]).join("，") + "。");
  return { id: `sample-${id}`, published: true, title: `合成内容 ${id}`, body: paragraphs.join("\n\n"), content: { type: "doc", content: paragraphs.map(text => ({ type: "paragraph", content: [{ type: "text", text }] })) }, date: "2026-10-14", createdAt: "2026-10-14T00:00:00.000Z" };
}
function measure(records, project) {
  const start = performance.now();
  const json = JSON.stringify(records.map(project));
  const serializeMs = performance.now() - start;
  const parsed = performance.now(); JSON.parse(json);
  const parseMs = performance.now() - parsed;
  return { bytes: Buffer.byteLength(json), gzipBytes: gzipSync(json).length, serializeMs: +serializeMs.toFixed(2), parseMs: +parseMs.toFixed(2) };
}
console.log(JSON.stringify({ synthetic: true, liveLatencyMeasured: false, scenarios: [100, 500].map(count => {
  const records = Array.from({ length: count }, (_, i) => sample(i));
  return { count, full: measure(records, record => publicContent(record, "posts")), summary: measure(records, record => publicSummary(record, "posts")) };
}) }, null, 2));
