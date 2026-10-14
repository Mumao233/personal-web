import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { surveyAnswerProgress } from "../server/validation.js";

const choice = { id: "gate", title: "资格", type: "single", options: ["继续", "结束"], required: true };
const matrix = { id: "matrix", title: "量表", type: "matrix", required: true, options: ["同意", "不同意"], rows: [{ id: "a", title: "第一行" }, { id: "b", title: "第二行" }] };
const progress = (questions, answers = {}) => surveyAnswerProgress({ questions }, answers);

test("empty single-section required survey starts at zero; optional items are excluded", () => {
  assert.deepEqual(progress([choice, { id: "note", type: "text" }]), { total: 1, answered: 0, percent: 0, terminated: false });
  assert.deepEqual(progress([{ id: "note", type: "text" }]), { total: 0, answered: 0, percent: 0, terminated: false });
  assert.equal(progress([choice], { gate: "无效选项" }).answered, 0);
  assert.equal(progress([choice], { gate: "继续" }).percent, 100);
});

test("matrix counts each validated required row and rejects malformed restored answers", () => {
  assert.equal(progress([matrix]).total, 2);
  assert.equal(progress([matrix], { matrix: { a: "同意" } }).percent, 50);
  assert.equal(progress([matrix], { matrix: { a: "同意", b: "无效" } }).percent, 50);
  assert.equal(progress([matrix], { matrix: { a: "同意", b: "不同意" } }).percent, 100);
  assert.equal(progress([matrix], { matrix: { a: "同意", extra: "同意" } }).percent, 0);
  assert.equal(progress([{ ...matrix, required: false }], { matrix: { a: "同意" } }).total, 0);
});

test("hidden and terminated downstream items do not inflate denominator", () => {
  const questions = [{ ...choice, terminateOptions: ["结束"] }, { ...matrix, condition: { questionId: "gate", value: "继续" } }];
  assert.equal(progress(questions).total, 1);
  assert.deepEqual(progress(questions, { gate: "继续", matrix: { a: "同意" } }), { total: 3, answered: 2, percent: 66, terminated: false });
  assert.deepEqual(progress(questions, { gate: "结束", matrix: { a: "同意" } }), { total: 1, answered: 1, percent: 100, terminated: true });
});

test("validation including other text, exclusivity, minimum and explicit ranking defines progress", () => {
  const q = { id: "multi", title: "选择", type: "multirank", required: true, options: ["A", "B", "以上都无"], min: 2, allowOther: true };
  for (const answers of [{ multi: ["A"] }, { multi: ["A", "其他"] }, { multi: ["A", "以上都无"] }]) assert.equal(progress([q], answers).answered, 0);
  assert.equal(progress([q], { multi: ["A", "其他"], multi__other: "说明" }).answered, 1);
  assert.equal(progress([q], { multi: ["以上都无"] }).answered, 1);
  const rank = { ...q, type: "rank", options: ["A", "B"], allowOther: false };
  assert.equal(progress([rank]).answered, 0);
  assert.equal(progress([rank], { multi: ["B", "A"] }).answered, 1);
  assert.equal(progress([{ id: "t", type: "text", title: "文字", required: true }], { t: "   " }).answered, 0);
});

let vite, Survey, QuestionInput;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, logLevel: "error" });
  ({ default: Survey, QuestionInput } = await vite.ssrLoadModule("/src/survey.jsx"));
});
after(async () => { await vite?.close(); });

test("rendered initial progress describes answered items independently from section number", () => {
  const html = renderToStaticMarkup(React.createElement(Survey, { preview: { title: "调查", questions: [choice] } }));
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /width:0%/);
  assert.match(html, /尚未提交/);
  assert.match(html, /第 1 \/ 1 部分/);
  const optional = renderToStaticMarkup(React.createElement(Survey, { preview: { title: "选填", questions: [{ ...choice, required: false }] } }));
  assert.match(optional, /全部为选填，可直接提交/);
  assert.doesNotMatch(optional, /role="progressbar"/);
});

test("unset and zero selection limits never render a stray zero", () => {
  for (const type of ["single", "multiple", "multirank", "rank", "text", "matrix"]) {
    for (const limits of [{}, { min: 0, max: 0 }, { min: 1 }, { max: 2 }]) {
      const html = renderToStaticMarkup(React.createElement(QuestionInput, { q: { ...matrix, ...limits, type }, onChange() {} }));
      assert.doesNotMatch(html, /<\/legend>0/);
      if (limits.min) assert.match(html, /至少1项/);
      if (limits.max) assert.match(html, /最多2项/);
    }
  }
});
