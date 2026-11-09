import React, {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  lazy,
  Suspense,
} from "react";
import { flushSync } from "react-dom";
import { ArrowRight, ArrowUpRight, Check } from "@phosphor-icons/react";
import { api } from "./api";
import { contentDateValue } from "../shared/content-date.js";
import {
  buildPublicPageMetadata,
  resolvePageRoute,
} from "../shared/page-info.js";
import Survey from "./survey";
import ArticleContent from "./article-content";
import { newSubmissionKey } from "./browser-state.js";
import ModuleBoundary from "./module-boundary.jsx";
import HomePage, { BlockTitle } from "./home-page.jsx";
import {
  NotFoundPage,
  PageHead,
  Pending,
  PublicPage,
  pageHeads,
} from "./public-pages.jsx";
import { SiteFooter, SiteHeader } from "./site-chrome.jsx";
import { ToastProvider, useToast } from "./toast.jsx";
import { ArticleBodySkeleton, DetailSkeleton, PageBodySkeleton } from "./skeleton.jsx";
import { byNewest, dotDate } from "./public-format.js";
import { takeSharedHandoff } from "./view-transition.js";
import "./design-tokens.css";
import "./public/base.css";
import "./public/home.css";
import "./public/pages.css";
import "./public/components.css";
export { PageHead, Text } from "./public-pages.jsx";

const Admin = lazy(() => import("./admin"));
const knownPages = ["home", "about", "projects", "notes", "world", "you", "us"];
const detailLabels = {
  post: { en: "Notes", all: "All notes", back: "回到随笔", unit: "篇" },
  project: { en: "Selected work", all: "All work", back: "回到作品", unit: "项" },
  story: { en: "The world", all: "All places", back: "回到影像", unit: "篇" },
};

function ArticleNav({ route, data }) {
  const labels = detailLabels[route.type];
  const list = data ? byNewest(data[route.collection] || [], route.collection) : [];
  const index = list.findIndex((item) => item.id === route.id);
  const previous = index >= 0 ? list[index + 1] : null;
  return (
    <nav className="article-nav" aria-label="上一篇与回到列表">
      {previous && (
        <a
          className="article-nav-link"
          href={`/?page=${route.page}&${route.type}=${encodeURIComponent(previous.id)}`}
        >
          <span className="article-nav-en">Previous</span>
          <span className="article-nav-title">{previous.title}</span>
          <span className="meta">
            {dotDate(contentDateValue(previous, route.collection))}
          </span>
        </a>
      )}
      <a className="article-nav-link is-all" href={`/?page=${route.page}`}>
        <span className="article-nav-en">{labels.all}</span>
        <span className="article-nav-title">{labels.back}</span>
        {data && (
          <span className="meta">
            {list.length} {labels.unit}
          </span>
        )}
      </a>
    </nav>
  );
}

function detailKicker(route, data) {
  const { en } = detailLabels[route.type];
  if (route.type !== "post" || !data) return en;
  const list = byNewest(data.posts, "posts");
  const index = list.findIndex((item) => item.id === route.id);
  if (index < 0) return en;
  return `${en}, N° ${String(list.length - index).padStart(2, "0")}`;
}

function DetailView({ route, data, detail, loading, error, onRetry, handoff }) {
  const shared = handoff?.id === route.id ? handoff : null;
  const kicker = (
    <a className="article-kicker" href={`/?page=${route.page}`}>
      {detailKicker(route, data)}
    </a>
  );
  return (
    <div className="reading article-reading" data-kind={route.type}>
      {loading ? (
        <>
          <p role="status" className="sr-only">
            正在读取完整内容…
          </p>
          {shared ? (
            <>
              <ArticleContent
                item={{ title: shared.title, cover: shared.cover }}
                kind={route.type}
                kicker={kicker}
                shared={shared.part}
              />
              <ArticleBodySkeleton />
            </>
          ) : (
            <DetailSkeleton />
          )}
        </>
      ) : detail ? (
        <>
          <ArticleContent
            item={detail}
            kind={route.type}
            kicker={kicker}
            shared={shared?.part}
          />
          <ArticleNav route={route} data={data} />
        </>
      ) : error && error.status !== 404 ? (
        <section className="state-panel" role="alert">
          <h1>暂时无法读取内容</h1>
          <p>{error.message}</p>
          <button type="button" className="button" onClick={onRetry}>
            重新读取
          </button>
        </section>
      ) : (
        <section className="state-panel article-not-found">
          <h1>这篇内容暂时不在这里。</h1>
          <p>可能尚未发布、已被移除，或链接不完整。可以返回列表看看其他记录。</p>
          <a className="text-link" href={`/?page=${route.page}`}>
            {detailLabels[route.type].back}
          </a>
        </section>
      )}
    </div>
  );
}

function App() {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  // Completion belongs to this document visit, never to storage or another tab.
  const [visit, setVisit] = useState(() => ({
    url: location.href,
    sequence: 0,
  }));
  const visitRef = useRef(visit);
  visitRef.current = visit;
  const [confirmedVisit, setConfirmedVisit] = useState(null);
  useLayoutEffect(() => {
    const restart = () => {
      const next = {
        url: location.href,
        sequence: visitRef.current.sequence + 1,
      };
      visitRef.current = next;
      flushSync(() => {
        setVisit(next);
        setConfirmedVisit(null);
      });
    };
    const restore = (event) => {
      if (event.persisted) restart();
    };
    window.addEventListener("popstate", restart);
    // Reset before a bfcache snapshot and again before a restored page is painted.
    window.addEventListener("pagehide", restore);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("popstate", restart);
      window.removeEventListener("pagehide", restore);
      window.removeEventListener("pageshow", restore);
    };
  }, []);
  const query = new URL(visit.url).searchParams;
  const route = resolvePageRoute(query);
  const [handoff] = useState(() => takeSharedHandoff(route));
  const standaloneEntry = route.type === "survey" && route.standalone;
  const standalone = standaloneEntry && confirmedVisit !== visit;
  const detailKind = route.collection ? route.type : null;
  const page = route.page;
  const home = page === "home" && route.type === "page";
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
      url: visit.url,
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
  }, [data, detail, page, route.id, route.type, visit.url]);
  if (page === "admin")
    return (
      <ModuleBoundary label="管理空间">
        <Suspense fallback={<div className="loading">正在打开后台…</div>}>
          <Admin />
        </Suspense>
      </ModuleBoundary>
    );
  const p = data?.profile || { name: "林珈诚" };
  const waitingForData = route.type === "page" && !data && !error;
  const busy = waitingForData || (detailKind && detailLoading);
  const loadFailure = error && !data && (
    <section className="page state-panel" role="alert">
      <h1>暂时无法打开</h1>
      <p>{error}</p>
      <button type="button" className="button" onClick={load}>
        重试
      </button>
    </section>
  );
  const pageBody = () => {
    if (loadFailure) return loadFailure;
    if (!knownPages.includes(page)) return <NotFoundPage />;
    if (!data)
      return (
        <div className="page">
          {pageHeads[page] && <PageHead {...pageHeads[page]} />}
          <PageBodySkeleton page={page} />
        </div>
      );
    return page === "us" ? (
      <Questions data={data} refresh={load} />
    ) : (
      <PublicPage page={page} data={data} />
    );
  };
  return (
    <ToastProvider>
      <a
        className="skip-main"
        href="#main-content"
        onClick={() => document.getElementById("main-content")?.focus()}
      >
        跳到主要内容
      </a>
      <div
        className={`site-content ${home ? "is-home" : ""} ${standalone ? "standalone-survey" : ""}`}
      >
        {!standalone && (
          <SiteHeader
            page={page}
            name={p.name}
            dark={home}
            visitSequence={visit.sequence}
          />
        )}
        <main id="main-content" tabIndex={-1} aria-busy={busy ? true : undefined}>
          {route.type === "answer" ? (
            <Answer token={query.get("answer")} />
          ) : route.type === "survey" ? (
            <Survey
              key={`${visit.sequence}:${route.id}:${standaloneEntry}`}
              id={route.id}
              standalone={standalone}
              onSubmissionSuccess={(submittedId) => {
                if (visitRef.current === visit && submittedId === route.id)
                  setConfirmedVisit(visit);
              }}
              onRestart={() => {
                if (visitRef.current === visit) setConfirmedVisit(null);
              }}
            />
          ) : detailKind ? (
            <DetailView
              route={route}
              data={data}
              detail={detail}
              loading={detailLoading}
              error={detailError}
              onRetry={() => setDetailAttempt((attempt) => attempt + 1)}
              handoff={handoff}
            />
          ) : home ? (
            (loadFailure && !data) ? loadFailure : <HomePage data={data} />
          ) : (
            pageBody()
          )}
        </main>
        {!standalone && <SiteFooter home={home} />}
      </div>
    </ToastProvider>
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
  const toast = useToast();
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
      toast.success("留言已收到");
      refresh();
    } catch (e) {
      setError(e.message);
      toast.error(e.message);
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
      else {
        setFound(r.message);
        toast.success(r.message);
      }
    } catch (e) {
      setFound(e.message);
      toast.error(e.message);
    }
  }
  return (
    <div className="page">
      <PageHead {...pageHeads.us} />
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
          <p className="page-aside">
            <a className="text-link" href="/?page=you">
              看看开放中的问卷
            </a>
          </p>
        </section>
        <aside>
          <BlockTitle zh="我们之间的对话" en="Words left here" />
          {data.messages.length ? (
            data.messages.map((m) => <Message key={m.id} m={m} report />)
          ) : (
            <Pending />
          )}
        </aside>
      </div>
    </div>
  );
}
function Message({ m, report = false }) {
  const [reported, setReported] = useState(false);
  const toast = useToast();
  return (
    <article className="message">
      <div className="message-meta">
        <span>{m.name || "匿名"}</span>
        <time className="meta">{dotDate(m.createdAt)}</time>
      </div>
      <p className="question-text">{m.question}</p>
      {m.reply ? (
        <div className="reply">
          <span className="meta">林珈诚的回复</span>
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
              toast.success("举报已提交");
            } catch (e) {
              toast.error(e.message);
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
    <div className="page">
      <PageHead
        title="你的提问"
        en="Just between us"
        subtitle="这个链接属于这一次对话。请妥善保存。"
      />
      {m ? <Message m={m} /> : <p>{error || "正在读取…"}</p>}
      <p className="page-aside">
        <a className="text-link" href="/?page=us">
          回到关于我们
        </a>
      </p>
    </div>
  );
}
// Keep rendering in bootstrap.jsx so Fast Refresh cannot create a second root.
export default App;
