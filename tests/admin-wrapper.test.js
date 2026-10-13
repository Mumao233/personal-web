import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import {
  runAdminRequest,
  runRemoteRequest,
  parseArguments,
  parseWorkbenchResult,
  validateRemoteDirectory,
} from "../scripts/admin-workbench.mjs";
import {
  renderPreview,
  createLocalPreview,
  collectMediaNames,
  decodeMediaFile,
  uploadName,
} from "../scripts/admin-preview.mjs";

const directories = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "personal-admin-wrapper-test-"));
  directories.push(path);
  return path;
}
after(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});
const remote = "/tmp/personal-web-admin-input.Abc123Zxy9";
const good = (value = { exit_code: 0, stdout: "" }) => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});
const png = {
  name: "private.png",
  mime: "image/png",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
};
const doc = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const preview = (overrides) => ({
  token: "preview-token",
  expiresAt: "2026-10-13T12:30:00.000Z",
  impactCount: 1,
  items: [
    {
      kind: "posts",
      id: "post-1",
      version: "version-1",
      action: "publish",
      target: "https://mumao.site/?article=posts&id=post-1",
      draft: { title: "草稿", content: doc("正文") },
      live: { title: "线上旧版", body: "现有正文" },
      changes: ["title", "content"],
      ...overrides,
    },
  ],
});

function mockTransport({
  response = { ok: true, results: [{ id: "draft-1" }] },
  directoryValue = remote,
  failRun = false,
  failUpload = false,
  failCleanup = false,
  handler,
} = {}) {
  const calls = [],
    requests = [],
    localInputs = [];
  let request;
  const executor = async (args) => {
    calls.push(args);
    if (args[0] === "upload") {
      request = JSON.parse(await readFile(args[1], "utf8"));
      requests.push(request);
      localInputs.push(args[1]);
      return failUpload
        ? {
            code: 4,
            stdout: JSON.stringify({ code: 4, message: "secret-token" }),
            stderr: "secret-token",
          }
        : good({ success: true });
    }
    if (args[0] === "download") {
      await writeFile(
        args[2],
        JSON.stringify(handler ? handler(request) : response),
      );
      return good({ success: true });
    }
    const command = args[args.indexOf("--command") + 1];
    if (command.includes("mktemp"))
      return good({ exit_code: 0, stdout: directoryValue + "\n" });
    if (command.startsWith("rm -f"))
      return failCleanup ? good({ exit_code: 1 }) : good();
    if (command.includes("server/admin-cli.js"))
      return failRun
        ? good({ exit_code: 0, stdout: "", timed_out: true })
        : good({
            exit_code: 0,
            stdout: (handler ? handler(request) : response).ok ? "0\n" : "1\n",
          });
    return good();
  };
  return { executor, calls, requests, localInputs };
}

test("wrapper sends hostile content only as uploaded JSON, never shell text, and downloads structured output", async () => {
  const transport = mockTransport();
  const body = "'; rm -rf /; $(cat ~/.credentials) `whoami`\nsecret-body";
  const request = {
    action: "apply",
    requestId: "same-request-1",
    operations: [
      { action: "create", kind: "posts", data: { title: "测试", body } },
    ],
  };
  const result = await runRemoteRequest(request, transport);
  assert.equal(result.ok, true);
  assert.deepEqual(transport.requests, [request]);
  for (const args of transport.calls) {
    assert.ok(args.includes("i-7xvfvftrswzogb3o6n05"));
    assert.ok(args.includes("cn-guangzhou"));
    assert.ok(
      !args.some((arg) => arg.includes(body) || arg.includes("secret-body")),
    );
    assert.ok(!args.includes("--force"));
  }
  const commands = transport.calls
    .filter((args) => args[0] === "exec")
    .map((args) => args.at(-1));
  assert.match(commands[1], /test ! -e .*input\.json/);
  assert.match(
    commands[2],
    /sudo -n -u personal-web env DATA_DIR=\/opt\/personal-web\/data \/usr\/local\/bin\/node \/opt\/personal-web\/app\/server\/admin-cli\.js </,
  );
  assert.match(commands[2], /> .*output\.json 2> .*error\.log/);
  assert.ok(transport.calls.some((args) => args[0] === "download"));
  assert.ok(
    commands.at(-1).startsWith("rm -f -- ") && !commands.at(-1).includes("-rf"),
  );
  await assert.rejects(readFile(transport.localInputs[0]), { code: "ENOENT" });
});

test("wrapper refuses hostile remote paths before upload and does not delete an unvalidated path", async () => {
  for (const value of [
    "/tmp/personal-web-admin-input.Abc123Zxy9; touch /oops",
    "/etc",
    remote + "/../x",
    remote + "\n/other",
  ]) {
    const transport = mockTransport({ directoryValue: value });
    const result = await runAdminRequest(
      { action: "list", kind: "posts" },
      transport,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "ADMIN_REMOTE_PATH");
    assert.equal(transport.calls.length, 1);
  }
  assert.equal(validateRemoteDirectory(remote), remote);
});

test("timeout after execution is unknown outcome and preserves safe retry guidance without secrets", async () => {
  const transport = mockTransport({ failRun: true });
  const result = await runAdminRequest(
    { action: "apply", requestId: "retry-this-id", operations: [] },
    transport,
  );
  assert.equal(result.ok, false);
  assert.equal(result.outcomeUnknown, true);
  assert.match(result.retry, /原 requestId/);
  assert.ok(transport.calls.at(-1).at(-1).startsWith("rm -f"));
});

test("failed upload is known not to have called server and raw Workbench credential text is suppressed", async () => {
  const transport = mockTransport({ failUpload: true });
  const result = await runAdminRequest(
    { action: "list", kind: "posts" },
    transport,
  );
  assert.equal(result.ok, false);
  assert.equal(result.outcomeUnknown, undefined);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.ok(
    !transport.calls.some((args) =>
      args.some((arg) => arg.includes("server/admin-cli.js")),
    ),
  );
});

test("application validation/conflict errors survive output download and cleanup failure stays a warning", async () => {
  const response = {
    ok: false,
    status: 409,
    code: "VERSION_CONFLICT",
    error: "内容已更新",
  };
  const transport = mockTransport({ response, failCleanup: true });
  const result = await runAdminRequest(
    { action: "apply", requestId: "retry-id", operations: [] },
    transport,
  );
  assert.equal(result.code, "VERSION_CONFLICT");
  assert.equal(result.status, 409);
  assert.equal(result.warnings.length, 1);
});

test("Workbench requires successful process and remote statuses and detects timeout", () => {
  for (const value of [
    { code: 0, stdout: "not-json" },
    good({ stdout: "hello" }),
    good({ exit_code: 1 }),
    good({ exit_code: 0, timed_out: true }),
    { code: 4, stdout: JSON.stringify({ exit_code: 0 }) },
    { timedOut: true },
  ])
    assert.throws(() => parseWorkbenchResult(value, { isExec: true }));
  assert.equal(
    parseWorkbenchResult(good({ exit_code: 0, output: "ok" }), { isExec: true })
      .output,
    "ok",
  );
});

test("CLI accepts only request and preview files, with no command, host, credential or auth override", () => {
  assert.deepEqual(
    parseArguments([
      "--input",
      "request.json",
      "--preview-dir",
      ".qa/previews",
    ]),
    { input: "request.json", previewDirectory: ".qa/previews" },
  );
  for (const args of [
    ["--command", "whoami"],
    ["--input", "x", "--instance-id", "other"],
    ["--input", "x", "--input", "y"],
    ["--input"],
    ["--help", "--input", "x"],
    [],
  ])
    assert.throws(() => parseArguments(args));
});

test("local media uploads become filename/base64 JSON and preserve idempotency key", async () => {
  const dir = await directory();
  await writeFile(join(dir, "photo.png"), Buffer.from(png.base64, "base64"));
  const transport = mockTransport();
  const result = await runAdminRequest(
    {
      action: "media-upload",
      requestId: "upload-retry-id",
      files: [{ path: "photo.png" }],
    },
    { ...transport, inputDirectory: dir },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(transport.requests[0].files, [
    { name: "photo.png", base64: png.base64 },
  ]);
  assert.equal(transport.requests[0].requestId, "upload-retry-id");
});

test("unsupported upload types, too many files, malformed base64 and non-content actions fail before network", async () => {
  for (const request of [
    { action: "exec", command: "id" },
    { action: "media-upload", files: [{ name: "video.mp4", base64: "AAAA" }] },
    {
      action: "media-upload",
      files: [{ name: "../secret.png", base64: "AAAA" }],
    },
    {
      action: "media-upload",
      files: [{ name: "image.png", base64: "not-base64" }],
    },
    {
      action: "media-upload",
      files: Array(21).fill({ name: "a.png", base64: "AAAA" }),
    },
  ]) {
    let called = false;
    const result = await runAdminRequest(request, {
      executor: async () => {
        called = true;
        return good();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  }
});

test("media references are limited to trusted upload basenames; paths and foreign hosts are excluded", () => {
  assert.equal(
    uploadName("https://mumao.site/uploads/private.png"),
    "private.png",
  );
  for (const value of [
    "/uploads/../secret.png",
    "/uploads/a%2fsecret.png",
    "/uploads/file.svg",
    "https://other.test/uploads/private.png",
    "/uploads/private.png?q=secret",
    "/uploads/name..png",
  ])
    assert.equal(uploadName(value), null);
  assert.deepEqual(
    collectMediaNames(
      preview({
        draft: {
          cover: "/uploads/private.png",
          photos: ["/uploads/private.png", "https://foreign.test/x.png"],
        },
        live: { cover: "/uploads/old.jpg" },
      }),
    ),
    ["private.png", "old.jpg"],
  );
});

test("local preview fetches only referenced media through media-get, embeds private images and never publishes", async () => {
  const dir = await directory();
  const local = preview({
    draft: { title: "带图", cover: "/uploads/private.png", body: "私有正文" },
  });
  const transport = mockTransport({
    handler: (request) =>
      request.action === "media-get"
        ? { ok: true, files: [png] }
        : { ok: true, preview: local },
  });
  const result = await runAdminRequest(
    { action: "preview", operations: [] },
    { ...transport, previewDirectory: dir },
  );
  assert.equal(result.ok, true);
  assert.equal(result.localPreview.mediaCount, 1);
  const html = await readFile(result.localPreview.path, "utf8");
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /私有正文/);
  assert.deepEqual(
    transport.requests.map((request) => request.action),
    ["preview", "media-get"],
  );
  assert.deepEqual(transport.requests[1].names, ["private.png"]);
});

test("HTML preview escapes all content, blocks executable links and does not load external images", () => {
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: '<script>alert("x")</script>',
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      },
      {
        type: "image",
        attrs: {
          src: "https://example.test/track.png",
          alt: '" onerror="alert(1)',
          caption: "<img src=x onerror=alert(1)>",
          align: "left",
          width: 50,
        },
      },
    ],
  };
  const document = new JSDOM(
    renderPreview(preview({ draft: { title: "<img src=x>", content } })),
  ).window.document;
  assert.equal(
    document.querySelectorAll("script,img,iframe,object,form,input,button")
      .length,
    0,
  );
  assert.equal(document.querySelector("[onerror]"), null);
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
  assert.ok(document.body.textContent.includes('<script>alert("x")</script>'));
  assert.match(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')
      .content,
    /form-action 'none'/,
  );
  assert.ok(document.querySelector(".align-left.width-50"));
  assert.ok(document.querySelector('a[href="https://example.test/track.png"]'));
});

test("matrix survey preview shows every row, choices, exclusion and termination rules without forms", () => {
  const html = renderPreview(
    preview({
      kind: "surveys",
      live: null,
      draft: {
        title: "资金问卷",
        questions: [
          {
            id: "q1",
            title: "选择",
            type: "multiple",
            options: ["有", "以上都无"],
            terminateOptions: ["以上都无"],
            required: true,
          },
          {
            id: "q2",
            title: "矩阵",
            type: "matrix",
            rows: [
              { id: "r1", title: "我感到资金紧张" },
              { id: "r2", title: "我希望兼职" },
            ],
            options: ["不同意", "同意"],
            condition: { questionId: "q1", value: "有" },
          },
        ],
      },
    }),
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll("tbody tr").length, 2);
  assert.equal(document.querySelectorAll("tbody td").length, 4);
  for (const text of [
    "选择后结束：以上都无",
    "互斥选项：以上都无",
    "显示条件：q1 选择「有」",
    "没有作答或提交入口",
  ])
    assert.ok(document.body.textContent.includes(text));
  assert.equal(
    document.querySelectorAll("form,input,textarea,button").length,
    0,
  );
});

test("profile preview preserves field order and makes hidden fields and biography visible for review", () => {
  const html = renderPreview(
    preview({
      kind: "profile",
      live: null,
      draft: {
        name: "测试者",
        intro: "简介",
        bio: "自述",
        fields: [
          {
            id: "a",
            label: "主页",
            value: "我的网站",
            href: "https://example.test/",
            visible: true,
          },
          { id: "b", label: "私有联系方式", value: "隐藏字段", visible: false },
        ],
      },
    }),
  );
  const document = new JSDOM(html).window.document;
  assert.deepEqual(
    [...document.querySelectorAll("dt")].map((node) => node.textContent),
    ["主页", "私有联系方式（栏目将隐藏）"],
  );
  assert.equal(
    document.querySelector(".hidden-field dd").textContent,
    "隐藏字段",
  );
  assert.ok(document.body.textContent.includes("自述"));
});

test("preview includes profile portrait, interests, timeline, contact switch and every survey display setting", () => {
  const profileDoc = new JSDOM(
    renderPreview(
      preview({
        kind: "profile",
        live: null,
        draft: {
          name: "网站身份",
          portrait: "/uploads/private.png",
          interests: [{ title: "研究", text: "研究内容", status: "进行中" }],
          timeline: [{ date: "2026", title: "经历条目", text: "经历内容" }],
          acceptQuestions: false,
          fields: [{ id: "name", key: "name", label: "姓名", visible: false }],
        },
      }),
      { "private.png": `data:image/png;base64,${png.base64}` },
    ),
  ).window.document;
  assert.equal(profileDoc.querySelector("img").alt, "头像");
  for (const text of [
    "姓名作为网站身份始终公开",
    "接受提问：关闭",
    "研究内容",
    "进行中",
    "经历条目",
    "经历内容",
  ])
    assert.ok(profileDoc.body.textContent.includes(text));
  const surveyDoc = new JSDOM(
    renderPreview(
      preview({
        kind: "surveys",
        live: null,
        draft: {
          title: "问卷",
          closed: true,
          questions: [
            {
              id: "q1",
              type: "text",
              title: "题目",
              section: "基本情况",
              description: "作答说明",
            },
          ],
        },
      }),
    ),
  ).window.document;
  for (const text of [
    "接收新答卷：已关闭",
    "分组：基本情况",
    "作答说明",
    "题目 ID：q1",
  ])
    assert.ok(surveyDoc.body.textContent.includes(text));
});

test("forged media type, mismatched names and failed downloads fail closed and clean preview directory", async () => {
  assert.throws(() =>
    decodeMediaFile({ ...png, name: "other.png" }, "private.png"),
  );
  assert.throws(() =>
    decodeMediaFile(
      {
        ...png,
        base64: Buffer.from("<svg onload=alert(1)>").toString("base64"),
      },
      "private.png",
    ),
  );
  assert.throws(() =>
    decodeMediaFile({ ...png, mime: "text/html" }, "private.png"),
  );
  const dir = await directory();
  await assert.rejects(
    createLocalPreview(preview({ draft: { cover: "/uploads/private.png" } }), {
      directory: dir,
      fetchMedia: async () => ({ ok: false }),
    }),
  );
  assert.deepEqual(await readdir(dir), []);
});

test("PDF is a local download link and never an embedded executable document", async () => {
  const dir = await directory();
  const pdf = {
    name: "attachment.pdf",
    mime: "application/pdf",
    base64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"),
  };
  const local = await createLocalPreview(
    preview({ draft: { title: "附件", link: "/uploads/attachment.pdf" } }),
    { directory: dir, fetchMedia: async () => ({ ok: true, files: [pdf] }) },
  );
  const document = new JSDOM(await readFile(local.path, "utf8")).window
    .document;
  assert.ok(document.querySelector('a[href="./attachment.pdf"]'));
  assert.equal(document.querySelectorAll("iframe,object,embed").length, 0);
});

test("valid 15MiB media survives upload conversion and preview validation without regex stack overflow", async () => {
  const bytes = Buffer.alloc(15 * 1024 * 1024, 32);
  bytes.write("%PDF-1.4");
  const file = {
    name: "large.pdf",
    mime: "application/pdf",
    base64: bytes.toString("base64"),
  };
  assert.equal(decodeMediaFile(file, file.name).length, bytes.length);
  const dir = await directory();
  await writeFile(join(dir, "large.pdf"), bytes);
  const transport = mockTransport();
  const result = await runAdminRequest(
    {
      action: "media-upload",
      requestId: "large-upload",
      files: [{ path: "large.pdf" }],
    },
    { ...transport, inputDirectory: dir },
  );
  assert.equal(result.ok, true);
  assert.equal(transport.requests[0].files[0].base64, file.base64);
});
