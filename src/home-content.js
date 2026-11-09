// Copy for the homepage that has no home in the admin yet.
// Project, essay, photo and survey content always comes from /api/public.

export const hero = {
  kicker: ["N° 01", "广州", "2026 · 秋"],
  titleLines: ["在技术", "与价值之间。"],
  subtitle: "Between technology and value.",
  photo: {
    alt: "黄昏时的广州天际线：广州塔与珠江新城的高楼亮起灯，地平线上压着一道橘红色的晚霞",
    place: "广州",
    // Fill in when known, e.g. "2026.10". The caption shows only the place until then.
    takenAt: "",
    width: 8020,
    height: 3437,
    basePath: "/images/hero/guangzhou-dusk",
  },
};

export const intro =
  "我是林珈诚，在暨南大学读金融。想成为一个真正看得懂技术的研究者，所以读财报，也写代码；空下来的时候，拿着 iPhone 去拍暮色。";

export const threads = [
  {
    numeral: "I",
    title: "研究",
    en: "Research",
    body: "科技行业的基本面研究：财报、产业，以及技术本身。眼下在做第一次实证研究，关心 AI 相关的信息披露怎样进入估值。",
    bodyShort: "科技行业的基本面研究：财报、产业，以及技术本身。",
    items: ["CFA Research Challenge 校内模拟 · 中际旭创", "第一次实证研究 · 学习中"],
  },
  {
    numeral: "II",
    title: "构建",
    en: "Building",
    body: "把想法做成能用的东西。和不同专业的同学一起做课堂里的 AI 系统，也给自己做一些顺手的小工具。",
    bodyShort: "把想法做成能用的东西：课堂里的 AI 系统，和顺手的小工具。",
    items: ["课间 Classroom OS · 开发中", "九格 · 太阳系图谱 · 这个网站"],
  },
  {
    numeral: "III",
    title: "观看",
    en: "Seeing",
    body: "偏爱暮色：克制的饱和度，压住的高光，留下的暗部。偶尔也用直闪，拍一点粗粝的日常。",
    bodyShort: "偏爱暮色：克制的饱和度，压住的高光，留下的暗部。",
    items: ["iPhone · Lightroom", "影像集 · 整理中"],
  },
];

export const notesQuote = {
  text: "“谁又能真正准备好了，才开始人生呢？”",
  source: "摘自《写在路上，生日之前》",
};

// Built-in works that live outside the projects table.
export const builtInWorks = {
  solar: {
    id: "solar",
    builtIn: true,
    href: "/solar/",
    art: "planet",
    title: "太阳系 · 人类造物图谱",
    excerpt: "漫游太阳系，走近航天任务，也从宇宙回到地球。一张可以亲自走进去的图谱。",
    category: "交互作品",
    meta: "交互作品",
    action: "进入图谱",
  },
  nineGrid: {
    id: "nine-grid",
    builtIn: true,
    href: "/nine-grid/",
    art: "grid",
    title: "九格 · 图片生成器",
    excerpt: "把日常装进九个小格，在浏览器里排版、裁切、导出。",
    category: "工具",
    meta: "2026.10 · 工具",
    action: "开始制作",
  },
};

export const footerContent = {
  name: "Lin Jiacheng",
  domain: "mumao.site",
  owner: "林珈诚",
  github: "https://github.com/Mumao233",
};
