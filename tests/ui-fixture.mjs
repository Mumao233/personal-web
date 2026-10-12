// Disposable local QA only. Never writes the real project's data directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "personal-space-ui-"));
const child = spawn(process.execPath, ["server/index.js", "--production"], {
  env: { ...process.env, PORT: "5188", DATA_DIR: dir, TEST_MODE: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  child.stdout.on("data", (b) => {
    if (b.toString().includes("Personal Space:")) resolve();
  });
  child.on("exit", reject);
});
const base = "http://127.0.0.1:5188/api";
let cookie;
const call = async (path, body) => {
  const r = await fetch(base + path, {
    method: path === "/setup" ? "POST" : "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  return r.json();
};
await call("/setup", { username: "qa", password: "local-qa-only-pass" });
const survey = await call("/admin/surveys/new", {
  title: "本地测试问卷（演示数据）",
  description: "仅用于界面验收，不是实际发布的研究。",
  published: true,
  successMessage: "测试回答已保存。",
  questions: [
    {
      id: "one",
      type: "single",
      title: "选择一个方向",
      options: ["金融", "技术"],
      required: true,
    },
    {
      id: "two",
      type: "multiple",
      title: "选择你的兴趣",
      options: ["照片", "旅行", "文字"],
      min: 1,
      max: 2,
      required: true,
    },
    {
      id: "three",
      type: "rank",
      title: "为三个选项排序",
      options: ["A", "B", "C"],
      required: true,
    },
    {
      id: "four",
      type: "multirank",
      title: "选择后再排序",
      options: ["甲", "乙", "丙"],
      required: true,
    },
    {
      id: "five",
      type: "text",
      title: "留一句话",
      required: true,
      section: "文字",
    },
    {
      id: "six",
      type: "text",
      title: "技术方向的补充",
      condition: { questionId: "one", value: "技术" },
      required: true,
      section: "文字",
    },
  ],
});
await call("/admin/stories/new", {
  title: "广州测试锚点（演示）",
  body: "这是地图功能测试，不代表用户旅行经历。",
  lat: 23.1291,
  lng: 113.2644,
  city: "广州",
  location: "广州",
  published: true,
  confirmLocation: true,
  photos: [],
  date: "2026-10-12",
});
console.log("UI QA server: http://localhost:5188");
console.log("QA survey id: " + survey.id);
async function stop() {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  await rm(dir, { recursive: true, force: true });
  process.exit();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
