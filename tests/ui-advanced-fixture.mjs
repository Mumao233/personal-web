// Disposable QA data only; never uses the project's or production data folder.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "personal-advanced-qa-"));
const port = process.env.QA_PORT || "5189";
const child = spawn(process.execPath, ["server/index.js", "--production"], {
  env: { ...process.env, PORT: port, DATA_DIR: dir, TEST_MODE: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  child.stdout.on("data", (b) => {
    if (b.toString().includes("Personal Space:")) resolve();
  });
  child.once("exit", (code) => reject(Error(`Server exited: ${code}`)));
});
const base = `http://127.0.0.1:${port}/api`;
let cookie;
async function call(path, body, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Error(JSON.stringify(result));
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  return result;
}
await call("/setup", { username: "qa", password: "local-qa-only-pass" });
const options = [
  "非常不同意",
  "比较不同意",
  "既不赞同也不反对",
  "比较同意",
  "非常同意",
];
const rows = [
  "我感到自己可支配的生活资金比较紧张。",
  "我担心自己的资金不足以支付日常开销。",
  "我难以负担一些对自己重要的消费。",
  "我希望通过兼职或其他方式，增加自己可支配的生活费。",
].map((title, index) => ({ id: `statement-${index + 1}`, title }));
const survey = await call(
  "/admin/surveys/new",
  {
    title: "矩阵与选项规则验收（本地演示）",
    description: "仅用于功能测试，以下示例答卷不是实际调查数据。",
    published: true,
    publicResults: true,
    terminationMessage: "本地提前结束流程已完成，谢谢。",
    questions: [
      {
        id: "screen",
        title: "是否继续参与本地测试？",
        type: "single",
        required: true,
        section: "开始",
        options: ["继续", "结束"],
        terminateOptions: ["结束"],
      },
      {
        id: "interests",
        title: "本地测试：选择兴趣",
        type: "multiple",
        required: true,
        section: "选择",
        min: 2,
        options: ["摄影", "音乐", "编程", "以上都无"],
      },
      {
        id: "matrix",
        title: "生活资金感受（示例量表）",
        type: "matrix",
        required: true,
        section: "评价",
        rows,
        options,
      },
      {
        id: "note",
        title: "补充说明（选填）",
        type: "text",
        required: false,
        section: "评价",
      },
    ],
  },
  "PUT",
);
for (let index = 0; index < 4; index++) {
  await call(`/surveys/${survey.id}/submit`, {
    answers: {
      screen: "继续",
      interests: index === 0 ? ["以上都无"] : ["摄影", "音乐"],
      matrix: Object.fromEntries(
        rows.map((row, offset) => [
          row.id,
          options[(index + offset) % options.length],
        ]),
      ),
      note: `功能测试记录 ${index + 1}`,
    },
  });
}
for (let index = 0; index < 2; index++)
  await call(`/surveys/${survey.id}/submit`, { answers: { screen: "结束" } });
console.log(`Advanced QA server: http://localhost:${port}/?page=admin`);
console.log(
  `Advanced QA survey: http://localhost:${port}/?survey=${survey.id}`,
);
async function stop() {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
