import React, { useEffect, useState, useRef, lazy, Suspense } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Plus,
  Minus,
  GlobeHemisphereEast,
  Envelope,
  WechatLogo as WeChatLogo,
  Phone,
  Check,
  LockSimple,
  X,
  List as MenuIcon,
} from "@phosphor-icons/react";
import { api, date } from "./api";
import { contentDateValue } from "../shared/content-date.js";
import {
  buildPublicPageMetadata,
  resolvePageRoute,
} from "../shared/page-info.js";
import { quotes } from "./quotes";
import Survey from "./survey";
import ArticleContent from "./article-content";
import { ProfileFields } from "./profile-fields";
import { sessionState, newSubmissionKey } from "./browser-state.js";
import ModuleBoundary from "./module-boundary.jsx";
import "./style.css";
import "./space.css";
const Admin = lazy(() => import("./admin"));
const World = lazy(() => import("./world"));
const Space = lazy(() => import("./space"));
const nav = [
  ["about", "关于我"],
  ["projects", "作品与项目"],
  ["notes", "随笔"],
  ["world", "关于世界"],
  ["you", "关于你"],
  ["us", "关于我们"],
];
export function Empty({
  title = "这里还在慢慢生长。",
  text = "新的记录，准备好后会留在这里。",
}) {
  return (
    <div className="empty">
      <span className="empty-line" />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function Text({ children }) {
  return (
    <div className="prose">
      {String(children || "")
        .split("\n\n")
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </div>
  );
}
export function Intro() {
  const [show, setShow] = useState(() => !sessionState.getItem("greeted"));
  const [word, setWord] = useState(0);
  const finish = () => {
    sessionState.setItem("greeted", "1");
    setShow(false);
  };
  useEffect(() => {
    if (!show) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const interval = setInterval(() => setWord((x) => x + 1), 440);
    const t = setTimeout(finish, 2600);
    return () => {
      clearInterval(interval);
      clearTimeout(t);
    };
  }, [show]);
  return (
    show && (
      <div className="intro" role="dialog" aria-label="欢迎">
        <span className="hello">
          {
            ["Hello", "你好", "Bonjour", "Hola", "こんにちは", "Hello"][
              word % 6
            ]
          }
          <span className="cursor">_</span>
        </span>
        <button onClick={finish}>
          跳过 <ArrowRight />
        </button>
        <span className="intro-caption">A SMALL SPACE IN A BIG WORLD</span>
      </div>
    )
  );
}
function TypeQuote() {
  const [text, setText] = useState("");
  useEffect(() => {
    let timer,
      disposed = false;
    let previous = -1;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const choose = () => {
      let n;
      do {
        n = Math.floor(Math.random() * quotes.length);
      } while (n === previous);
      previous = n;
      return quotes[n][Math.random() < 0.5 ? 0 : 1];
    };
    let sentence = choose();
    let visible = "";
    const step = () => {
      if (disposed) return;
      if (visible.length < sentence.length) {
        visible = sentence.slice(0, visible.length + 1);
        setText(visible);
        timer = setTimeout(step, /[\u4e00-\u9fff]/.test(sentence) ? 95 : 45);
      } else timer = setTimeout(erase, 15000);
    };
    const erase = () => {
      if (disposed) return;
      if (reduced) {
        sentence = choose();
        visible = sentence;
        setText(visible);
        timer = setTimeout(erase, 15000);
        return;
      }
      if (visible.length) {
        visible = visible.slice(0, -1);
        setText(visible);
        timer = setTimeout(erase, 22);
      } else {
        sentence = choose();
        timer = setTimeout(step, 400);
      }
    };
    if (reduced) {
      visible = sentence;
      setText(sentence);
      timer = setTimeout(erase, 15000);
    } else
      timer = setTimeout(step, sessionState.getItem("greeted") ? 550 : 2900);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return (
    <p className="typed" aria-label="首页文案">
      {text}
      <span className="cursor">|</span>
    </p>
  );
}
function App() {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [menu, setMenu] = useState(false);
  const query = new URLSearchParams(location.search);
  const route = resolvePageRoute(query);
  const detailKind = route.collection ? route.type : null;
  const detailPage = route.page;
  const page = route.page;
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(!!route.collection);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const load = () => {
    setError("");
    return api("/public?view=summary")
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!route.collection) return;
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    api(`/content/${route.collection}/${encodeURIComponent(route.id || "")}`)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((reason) => {
        if (!cancelled) setDetailError(reason);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [route.collection, route.id, detailAttempt]);
  useEffect(() => {
    if (!data) return;
    const publicData =
      detail && route.collection
        ? {
            ...data,
            [route.collection]: [
              { ...detail, id: route.id },
              ...(data[route.collection] || []).filter(
                (item) => item.id !== route.id,
              ),
            ],
          }
        : data;
    const canonicalOrigin = new URL(
      document.head.querySelector('link[rel="canonical"]')?.href ||
        location.origin,
    ).origin;
    const metadata = buildPublicPageMetadata({
      url: location.href,
      origin: canonicalOrigin,
      publicData,
    });
    document.title = metadata.title;
    const update = (selector, attributes) => {
      let node = document.head.querySelector(selector);
      if (!node) {
        node = document.createElement(
          selector.startsWith("link") ? "link" : "meta",
        );
        document.head.appendChild(node);
      }
      Object.entries(attributes).forEach(([key, value]) =>
        node.setAttribute(key, value),
      );
    };
    update('meta[name="description"]', {
      name: "description",
      content: metadata.description,
    });
    update('link[rel="canonical"]', {
      rel: "canonical",
      href: metadata.canonical,
    });
    for (const [key, value] of Object.entries({
      title: metadata.title,
      description: metadata.description,
      url: metadata.canonical,
      type: metadata.type,
      site_name: metadata.siteName,
    }))
      update(`meta[property="og:${key}"]`, {
        property: `og:${key}`,
        content: value,
      });
    if (metadata.image)
      update('meta[property="og:image"]', {
        property: "og:image",
        content: metadata.image,
      });
    else document.head.querySelector('meta[property="og:image"]')?.remove();
    if (metadata.noindex)
      update('meta[name="robots"]', {
        name: "robots",
        content: "noindex, nofollow",
      });
    else document.head.querySelector('meta[name="robots"]')?.remove();
  }, [data, detail, page, route.id, route.type]);
  if (page === "admin")
    return (
      <ModuleBoundary label="管理空间">
        <Suspense fallback={<div className="loading">正在打开后台…</div>}>
          <Admin />
        </Suspense>
      </ModuleBoundary>
    );
  if (!data)
    return (
      <div className="loading">
        {error || "正在打开个人空间…"}
        {error && <button onClick={load}>重试</button>}
      </div>
    );
  const p = data.profile;
  return (
    <>
      <a
        className="skip-main"
        href="#main-content"
        onClick={() => document.getElementById("main-content")?.focus()}
      >
        跳到主要内容
      </a>
      <Intro />
      <ModuleBoundary label="3D 场景" quiet>
        <Suspense fallback={null}>
          <Space
            home={
              page === "home" &&
              !detailKind &&
              !query.has("answer") &&
              !query.has("survey")
            }
          />
        </Suspense>
      </ModuleBoundary>
      <div
        className={`site-content ${page === "home" && !detailKind ? "is-home" : ""}`}
      >
        <header className="header">
          <a className="wordmark" href="/">
            {p.name}
            <span>PERSONAL SPACE</span>
          </a>
          <button
            className="menu-toggle"
            aria-label="导航"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X /> : <MenuIcon />}
          </button>
          <nav aria-label="主要导航" className={menu ? "open" : ""}>
            {nav.map(([key, label]) => (
              <a
                className={page === key ? "active" : ""}
                aria-current={page === key ? "page" : undefined}
                key={key}
                href={"/?page=" + key}
              >
                {label}
              </a>
            ))}
          </nav>
        </header>
        <main id="main-content" tabIndex={-1}>
          {route.type === "answer" ? (
            <Answer token={query.get("answer")} />
          ) : route.type === "survey" ? (
            <Survey id={query.get("survey")} />
          ) : detailKind ? (
            <div className="reading article-reading">
              <a className="back" href={"/?page=" + detailPage}>
                <ArrowLeft /> 返回{nav.find(([key]) => key === detailPage)?.[1]}
              </a>
              {detailLoading ? (
                <p role="status">正在读取完整内容…</p>
              ) : detail ? (
                <ArticleContent item={detail} kind={detailKind} />
              ) : detailError && detailError.status !== 404 ? (
                <section role="alert">
                  <h1>暂时无法读取内容</h1>
                  <p>{detailError.message}</p>
                  <button
                    type="button"
                    onClick={() => setDetailAttempt((attempt) => attempt + 1)}
                  >
                    重新读取
                  </button>
                </section>
              ) : (
                <section className="article-not-found">
                  <span className="eyebrow">ARTICLE NOT FOUND</span>
                  <h1>这篇内容暂时不在这里。</h1>
                  <p>
                    可能尚未发布、已被移除，或链接不完整。可以返回列表看看其他记录。
                  </p>
                </section>
              )}
            </div>
          ) : (
            <>
              {page === "home" && (
                <>
                  <section className="hero">
                    <div className="hero-kicker">
                      <span className="dot" /> 一个不断生长的个人空间
                    </div>
                    <h1>
                      {p.name}
                      <span className="name-en">LIN JIACHENG</span>
                    </h1>
                    <TypeQuote />
                    <div className="hero-actions">
                      <a className="button copper-button" href="/solar/">
                        探索太阳系 <ArrowUpRight />
                      </a>
                      <a className="hero-secondary" href="#explore">
                        走进我的空间 <ArrowRight />
                      </a>
                    </div>
                    <div className="hero-bottom">
                      <span>克制 / 好奇 / 浪漫</span>
                      <a href="#explore">
                        慢慢往下看 <ArrowRight />
                      </a>
                    </div>
                    <div className="scene-caption" aria-hidden="true">
                      <span className="scene-caption-line" />
                      一小片宇宙，
                      <br />
                      一些想慢慢了解的事。
                    </div>
                  </section>
                  <section
                    className="solar-feature"
                    aria-labelledby="solar-feature-title"
                  >
                    <div className="solar-feature-heading">
                      <span className="eyebrow">01 / FEATURED EXPLORATION</span>
                      <span className="solar-feature-type">
                        交互作品 · 持续探索
                      </span>
                    </div>
                    <div className="solar-feature-content">
                      <div>
                        <h2 id="solar-feature-title">
                          从这里，
                          <br />
                          <span>去更远的地方。</span>
                        </h2>
                        <p>
                          太阳系、航天器与我们留下的轨迹。
                          <br />
                          一张可以亲自走进去的图谱。
                        </p>
                        <a className="text-link" href="/solar/">
                          进入太阳系 <ArrowUpRight />
                        </a>
                      </div>
                      <a
                        className="solar-feature-art"
                        href="/solar/"
                        aria-label="进入太阳系完整作品"
                      >
                        <span className="solar-feature-orbit orbit-a" />
                        <span className="solar-feature-orbit orbit-b" />
                        <span className="solar-feature-orbit orbit-c" />
                        <span className="solar-feature-planet" />
                        <span className="solar-feature-moon" />
                        <span className="solar-feature-art-label">
                          SOLAR SYSTEM ATLAS <ArrowUpRight />
                        </span>
                      </a>
                    </div>
                  </section>
                  <section className="home-about" id="explore">
                    <span className="eyebrow">02 / A LITTLE ABOUT ME</span>
                    <h2>
                      一些关于我，
                      <br />
                      <span className="muted">和我正在认识的世界。</span>
                    </h2>
                    <div className="intro-copy">
                      <p>{p.intro}</p>
                      <a className="text-link" href="/?page=about">
                        再了解一点 <ArrowUpRight />
                      </a>
                    </div>
                  </section>
                  <section className="directory">
                    <div className="section-head">
                      <span className="eyebrow">03 / WANDER AROUND</span>
                      <p>你可以从任何地方开始。</p>
                    </div>
                    {nav.slice(1).map(([key, label], i) => (
                      <a
                        className="directory-row"
                        key={key}
                        href={"/?page=" + key}
                      >
                        <span className="mono">0{i + 1}</span>
                        <h3>{label}</h3>
                        <p>
                          {
                            [
                              "留下一些做过的事。",
                              "把未想明白的事写下来。",
                              "地点、照片，以及当时的光。",
                              "一些问题，想听听你的答案。",
                              "你想说的话，可以留在这里。",
                            ][i]
                          }
                        </p>
                        <ArrowUpRight />
                      </a>
                    ))}
                  </section>
                  <section className="home-end">
                    <span className="eyebrow">STILL EXPLORING</span>
                    <p>
                      世界还在展开。
                      <br />
                      我也一样。
                    </p>
                    <a href="/?page=us">
                      很高兴，在这里遇见你 <ArrowUpRight />
                    </a>
                  </section>
                </>
              )}
              {page === "about" && (
                <div className="page">
                  <PageHead
                    label="ABOUT ME"
                    title="关于我"
                    subtitle="比起一个定义，更像一些正在发生的事。"
                  />
                  <div className="about-layout">
                    <div>
                      {p.portrait ? (
                        <img
                          className="portrait"
                          src={p.portrait}
                          alt={p.name}
                        />
                      ) : (
                        <div className="portrait-placeholder">
                          <span>林</span>
                          <small>照片，等一个合适的时刻。</small>
                        </div>
                      )}
                    </div>
                    <Text>{p.bio}</Text>
                  </div>
                  <Contact p={p} />
                  <section className="subsection">
                    <h2>最近在关注</h2>
                    <div className="interest-grid">
                      {p.interests.map((x, i) => (
                        <div key={i}>
                          <span className="eyebrow">
                            0{i + 1} / {x.status}
                          </span>
                          <h3>{x.title}</h3>
                          <p>{x.text}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="subsection">
                    <h2>一些经历</h2>
                    {p.timeline.map((x, i) => (
                      <div className="timeline" key={i}>
                        <span>{x.date}</span>
                        <div>
                          <h3>{x.title}</h3>
                          <p>{x.text}</p>
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              )}
              {page === "projects" && (
                <div className="page">
                  <PageHead
                    label="SELECTED WORK & EXPLORATIONS"
                    title="作品与项目"
                    subtitle="做过的事，与正在尝试的可能。"
                  />
                  <a className="solar-project-entry" href="/solar/">
                    <span className="eyebrow">INTERACTIVE EXPLORATION</span>
                    <h2>
                      太阳系 · 人类造物图谱 <ArrowUpRight />
                    </h2>
                    <p>漫游太阳系，走近航天任务，也从宇宙回到地球。</p>
                    <span className="text-link">
                      打开完整作品 <ArrowUpRight />
                    </span>
                  </a>
                  {data.projects.length ? (
                    <div className="work-grid">
                      {data.projects.map((x, i) => (
                        <a
                          className="work"
                          href={"/?page=projects&project=" + x.id}
                          key={x.id}
                        >
                          {x.cover ? (
                            <img src={x.cover} alt="" />
                          ) : (
                            <div className="work-cover">
                              <span className="mono">0{i + 1}</span>
                              <span>{x.category}</span>
                            </div>
                          )}
                          <div className="work-meta">
                            <span className="eyebrow">{x.status}</span>
                            <ArrowUpRight />
                          </div>
                          <h2>{x.title}</h2>
                          <p>{x.excerpt || "打开查看完整项目"}</p>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="作品正在整理。"
                      text="等照片、报告与过程准备好，再把完整的故事留在这里。"
                    />
                  )}
                </div>
              )}
              {page === "notes" && (
                <div className="page">
                  <PageHead
                    label="NOTES & THOUGHTS"
                    title="随笔"
                    subtitle="有些问题，可以暂时没有答案。"
                  />
                  {data.posts.length ? (
                    data.posts.map((x) => (
                      <a
                        className="note-row"
                        href={"/?page=notes&post=" + x.id}
                        key={x.id}
                      >
                        <span className="mono">
                          {date(contentDateValue(x, "posts"))}
                        </span>
                        <div>
                          <h2>{x.title}</h2>
                          <p>{x.excerpt || "打开阅读全文"}</p>
                        </div>
                        <ArrowUpRight />
                      </a>
                    ))
                  ) : (
                    <Empty
                      title="第一篇，还在路上。"
                      text="关于学习、生活，以及那些值得多想一会儿的事。"
                    />
                  )}
                </div>
              )}
              {page === "world" && (
                <div className="page wide">
                  <PageHead
                    label="PLACES, MOMENTS & LIGHT"
                    title="关于世界"
                    subtitle="用问题靠近世界，用照片留住片刻。"
                  />
                  <ModuleBoundary label="世界地图">
                    <Suspense
                      fallback={<div className="loading">正在展开地球…</div>}
                    >
                      <World stories={data.stories} />
                    </Suspense>
                  </ModuleBoundary>
                </div>
              )}
              {page === "you" && (
                <div className="page">
                  <PageHead
                    label="I WONDER ABOUT YOU"
                    title="关于你"
                    subtitle="这次，想听听你的答案。"
                  />
                  {data.surveys.length ? (
                    data.surveys.map((s) => (
                      <a
                        className="survey-card"
                        key={s.id}
                        href={"/?page=you&survey=" + s.id}
                      >
                        <span className="eyebrow">
                          {s.closed
                            ? "已关闭"
                            : s.startsAt && Date.now() < Date.parse(s.startsAt)
                              ? "尚未开始"
                              : s.endsAt && Date.now() > Date.parse(s.endsAt)
                                ? "已结束"
                                : "开放填写"}{" "}
                          · {s.questionCount} 个问题
                        </span>
                        <h2>{s.title}</h2>
                        <p>{s.description}</p>
                        <span className="text-link">
                          打开问卷 <ArrowRight />
                        </span>
                      </a>
                    ))
                  ) : (
                    <Empty
                      title="新的问题，正在酝酿。"
                      text="这里会发布问卷，聊聊生活、选择，或值得研究的问题。"
                    />
                  )}
                </div>
              )}
              {page === "us" && <Questions data={data} refresh={load} />}
              {![
                "home",
                "about",
                "projects",
                "notes",
                "world",
                "you",
                "us",
              ].includes(page) && <Empty title="这一页还不存在。" />}
            </>
          )}
        </main>
        <footer>
          <a href="/">林珈诚 · 个人空间</a>
          <span>慢慢认识世界，也慢慢认识自己。</span>
          <a href="/?page=admin">
            管理 <ArrowUpRight />
          </a>
          <small>© {new Date().getFullYear()} LIN JIACHENG</small>
        </footer>
      </div>
    </>
  );
}
export function PageHead({ label, title, subtitle }) {
  return (
    <div className="page-head">
      <span className="eyebrow">{label}</span>
      <h1>
        {title}
        <span className="tiny-dot">.</span>
      </h1>
      <p>{subtitle}</p>
    </div>
  );
}
function Contact({ p }) {
  return (
    <div className="contact" id="profile">
      <span className="eyebrow">PROFILE / 个人资料</span>
      <ProfileFields profile={p} />
    </div>
  );
}
export function Questions({ data, refresh }) {
  const [b, setB] = useState({
      question: "",
      anonymous: true,
      public: true,
      name: "",
      recovery: "",
    }),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key, setKey] = useState(""),
    [found, setFound] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const attempt = useRef(null);
  const inflight = useRef(false);
  const set = (k, v) => setB((previous) => ({ ...previous, [k]: v }));
  async function submit(e) {
    e.preventDefault();
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError("");
    try {
      attempt.current ||= { ...b, submissionKey: newSubmissionKey() };
      setResult(
        await api("/questions", { method: "POST", body: attempt.current }),
      );
      setUncertain(false);
      refresh();
    } catch (e) {
      setError(e.message);
      const unknown =
        !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
      setUncertain(unknown);
      if (!unknown) attempt.current = null;
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }
  async function recover(e) {
    e.preventDefault();
    setFound("");
    try {
      const r = await api("/recover", { method: "POST", body: { key } });
      if (r.link) location.href = r.link;
      else setFound(r.message);
    } catch (e) {
      setFound(e.message);
    }
  }
  return (
    <div className="page">
      <PageHead
        label="A CONVERSATION BETWEEN US"
        title="关于我们"
        subtitle="一个问题，一句问候，或者一段还没说出口的话。"
      />
      <div className="conversation-layout">
        <section>
          {result ? (
            <div className="success">
              <Check size={36} />
              <h2>你的话，收到了。</h2>
              <p>请保存专属链接。它可以查看这次提问和之后的回复。</p>
              <label>
                专属链接
                <input
                  aria-label="专属链接"
                  readOnly
                  value={location.origin + result.link}
                />
              </label>
              <label>
                私密找回字符串
                <input
                  aria-label="私密找回字符串"
                  readOnly
                  value={result.recoveryPhrase}
                />
              </label>
              <a className="button" href={result.link}>
                查看我的提问 <ArrowRight />
              </a>
              <button
                className="quiet"
                onClick={() => {
                  setResult(null);
                  setB((previous) => ({ ...previous, question: "" }));
                  attempt.current = null;
                }}
              >
                再留一句话
              </button>
            </div>
          ) : (
            <form className="question-form" onSubmit={submit}>
              <fieldset
                className="submission-fields"
                disabled={busy || uncertain}
              >
                <label>
                  想对我说什么？
                  <textarea
                    required
                    maxLength={5000}
                    rows={6}
                    value={b.question}
                    onChange={(e) => set("question", e.target.value)}
                    placeholder="不必准备好一个完美的问题。"
                  />
                </label>
                <div className="form-options">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={b.anonymous}
                      onChange={(e) => set("anonymous", e.target.checked)}
                    />
                    匿名
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={b.public}
                      onChange={(e) => set("public", e.target.checked)}
                    />
                    公开这条提问
                  </label>
                </div>
                {!b.anonymous && (
                  <label>
                    你的署名
                    <input
                      required
                      maxLength={80}
                      value={b.name}
                      onChange={(e) => set("name", e.target.value)}
                      placeholder="你想使用的名字"
                    />
                  </label>
                )}
                <label>
                  找回方式 <span className="optional">选填</span>
                  <input
                    maxLength={320}
                    value={b.recovery}
                    onChange={(e) => set("recovery", e.target.value)}
                    placeholder="邮箱、手机号，或至少8位私密字符串"
                  />
                </label>
              </fieldset>
              {uncertain && (
                <p className="fine" role="status">
                  提交结果尚未确认。请重试确认这一次提交，系统不会重复保存。
                </p>
              )}
              <p className="fine">
                联系方式不会公开。收到回复后会发送通知；也可凭专属链接或私密字符串查看。
                {b.public
                  ? "这条提问提交后会立即公开。"
                  : "这条提问只对你和我可见。"}
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="button"
                disabled={busy || (!uncertain && !data.profile.acceptQuestions)}
              >
                {busy
                  ? "正在提交…"
                  : uncertain
                    ? "重试确认提交结果"
                    : data.profile.acceptQuestions
                      ? "把话留在这里"
                      : "提问暂时关闭"}
                <ArrowUpRight />
              </button>
            </form>
          )}
          <details className="recover">
            <summary>找回之前的提问</summary>
            <form onSubmit={recover}>
              <label>
                私密字符串／邮箱／手机号
                <input
                  required
                  maxLength={320}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              <button className="quiet">
                找回回答 <ArrowRight />
              </button>
              <p className="fine">
                使用联系方式查询时，查看入口会发送到该邮箱或手机。
              </p>
              {found && <p role="status">{found}</p>}
            </form>
          </details>
        </section>
        <aside>
          <span className="eyebrow">WORDS LEFT HERE</span>
          <h2>我们之间的对话</h2>
          {data.messages.length ? (
            data.messages.map((m) => <Message key={m.id} m={m} report />)
          ) : (
            <Empty title="这里还很安静。" text="你可以留下第一句话。" />
          )}
        </aside>
      </div>
    </div>
  );
}
function Message({ m, report = false }) {
  const [reported, setReported] = useState(false);
  return (
    <article className="message">
      <div className="message-meta">
        <span>{m.name || "匿名"}</span>
        <time>{date(m.createdAt)}</time>
      </div>
      <p className="question-text">{m.question}</p>
      {m.reply ? (
        <div className="reply">
          <span className="eyebrow">林珈诚的回复</span>
          <p>{m.reply}</p>
        </div>
      ) : (
        <span className="fine">等待回复</span>
      )}
      {report && (
        <button
          className="report"
          disabled={reported}
          onClick={async () => {
            try {
              await api("/questions/" + m.id + "/report", {
                method: "POST",
                body: { reason: "访客举报" },
              });
              setReported(true);
            } catch (e) {
              alert(e.message);
            }
          }}
        >
          {reported ? "已提交举报" : "举报"}
        </button>
      )}
    </article>
  );
}
function Answer({ token }) {
  const [m, setM] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    api("/answers/" + token)
      .then(setM)
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <div className="reading">
      <a className="back" href="/?page=us">
        <ArrowLeft /> 关于我们
      </a>
      <PageHead
        label="JUST BETWEEN US"
        title="你的提问"
        subtitle="这个链接属于这一次对话。请妥善保存。"
      />
      {m ? <Message m={m} /> : <p>{error || "正在读取…"}</p>}
    </div>
  );
}
// Keep rendering in bootstrap.jsx so Fast Refresh cannot create a second root.
export default App;
