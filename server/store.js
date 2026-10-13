import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
export const dataDir = resolve(process.env.DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true });
mkdirSync(resolve(dataDir, "uploads"), { recursive: true });
export const db = new DatabaseSync(resolve(dataDir, "space.sqlite"));
db.exec(
  `PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);`,
);
export const list = (kind) =>
  db
    .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
    .all(kind)
    .map((x) => JSON.parse(x.body));
export const get = (kind, id) => {
  const r = db
    .prepare("SELECT body FROM records WHERE kind=? AND id=?")
    .get(kind, id);
  return r ? JSON.parse(r.body) : null;
};
export const put = (kind, item) => {
  db.prepare(
    "INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
  ).run(kind, item.id, JSON.stringify(item));
  return item;
};
export const remove = (kind, id) =>
  db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
// All callbacks are synchronous: never hold a database transaction across I/O.
export function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export const setting = (key, fallback = null) => {
  const r = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return r ? JSON.parse(r.value) : fallback;
};
export const setSetting = (key, value) =>
  db
    .prepare(
      "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(key, JSON.stringify(value));
if (!setting("profile"))
  setSetting("profile", {
    name: "林珈诚",
    intro:
      "我叫林珈诚，在暨南大学学习金融。这个网站用来保存我做过的事、正在思考的问题，以及一些暂时没有答案的观察与记录。",
    bio: "我叫林珈诚，目前在暨南大学国际学院学习金融学。\n\n我把这个网站当作一个长期存在的个人空间，而不是一份放大优点的线上简历。这里会留下我真正做过的项目、参加过的比赛、学习过程中产生的问题，也会放一些文字、照片和旅行记录。\n\n过去的经历并不都围绕金融展开。我曾连续六年担任班级电教员，参加过头脑奥林匹克竞赛，也独立做过实验。进入大学以后，我开始更系统地接触金融、研究、竞赛和技术工具，同时也希望保留摄影、旅行和写作这些与“效率”没有太大关系的部分。\n\n我喜欢把问题弄明白，也接受有些事情暂时没有答案。这个网站大概也会一直处于这种状态：不断增加、修改和重新理解，而不是在某一天被正式“完成”。",
    email: "",
    phone: "",
    wechat: "",
    github: "",
    portrait: "",
    acceptQuestions: true,
    interests: [
      {
        title: "金融与大学生研究",
        text: "从大学生日常生活中寻找值得研究、又能真正获得数据的问题。",
        status: "选题与学习研究方法",
      },
      {
        title: "第一次认真做实证研究",
        text: "学习从研究问题、文献、数据到统计分析与写作的过程。",
        status: "学习中",
      },
      {
        title: "竞赛与项目",
        text: "参与研究、市场调查和金融分析类竞赛，认真走完完整的项目流程。",
        status: "进行中",
      },
      {
        title: "一个真正属于自己的空间",
        text: "让作品、想法、照片和生活可以同时存在。",
        status: "正在生长",
      },
      {
        title: "技术怎样参与日常生活",
        text: "探索 AI、Python 和个人工具，寻找值得解决的小问题。",
        status: "兴趣与探索",
      },
    ],
    timeline: [
      {
        date: "2026 — 至今",
        title: "暨南大学",
        text: "国际学院 · 金融学 · 2026级本科生",
      },
      {
        date: "学生时期",
        title: "头脑奥林匹克竞赛",
        text: "曾担任队长。省一等奖、全国赛 OMER 奖；年份与项目材料待补充。",
      },
      {
        date: "高中阶段",
        title: "独立实验",
        text: "独立完成金在西林瓶壁上还原实验，并整理实验报告。",
      },
      { date: "连续六年", title: "班级电教员", text: "具体起止年份待补充。" },
    ],
  });
if (!setting("seeded")) {
  for (const p of [
    {
      title: "金在西林瓶壁上还原实验",
      category: "实验",
      body: "高中阶段的一次个人实验。独立完成实验并整理报告。\n\n实验正式名称、时间、方法与照片待补充。",
      status: "已完成实验 · 材料待整理",
    },
    {
      title: "头脑奥林匹克竞赛",
      category: "竞赛",
      body: "曾担任队长，随团队参加比赛，获省一等奖与全国赛 OMER 奖。\n\n年份、参赛题目与实际分工待补充。",
      status: "材料待整理",
    },
    {
      title: "课程表增强应用",
      category: "构想",
      body: "探索课程、考试、临时调课、节假日、空闲时间与可视化的学习安排工具。当前为产品构想。",
      status: "构想阶段",
    },
    {
      title: "个人网站 / Personal Space",
      category: "网站",
      body: "一个首先属于自己的网络空间。\n\n我确定了定位、视觉方向和功能需求，整理个人材料，使用 AI 辅助设计与开发。",
      status: "建设中",
    },
  ])
    put("projects", {
      ...p,
      id: crypto.randomUUID(),
      published: false,
      createdAt: new Date().toISOString(),
      cover: "",
      link: "",
    });
  setSetting("seeded", true);
}
