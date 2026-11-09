import React, { lazy, Suspense, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { surveyVisitUrl } from "../shared/page-info.js";
import { ProfileFields } from "./profile-fields";
import ModuleBoundary from "./module-boundary.jsx";
import SegmentedControl from "./segmented-control.jsx";
import HoverPreview from "./hover-preview.jsx";
import WorkList from "./work-list.jsx";
import { BlockTitle, NoteRow } from "./home-page.jsx";
import { PageBodySkeleton } from "./skeleton.jsx";
import {
  byNewest,
  hiddenProfileField,
  surveyState,
  withoutPlaceholder,
  workCategories,
  worksFrom,
} from "./public-format.js";

const World = lazy(() => import("./world"));

export const pageHeads = {
  about: { title: "关于我", en: "About", subtitle: "比起一个定义，更像一些正在发生的事。" },
  projects: { title: "作品与项目", en: "Selected work", subtitle: "做过的事，与正在尝试的可能。" },
  notes: { title: "随笔", en: "Notes", subtitle: "有些问题，可以暂时没有答案。" },
  world: { title: "关于世界", en: "The world", subtitle: "用问题靠近世界，用照片留住片刻。" },
  you: { title: "关于你", en: "About you", subtitle: "这次，想听听你的答案。" },
  us: { title: "关于我们", en: "Between us", subtitle: "一个问题，一句问候，或者一段还没说出口的话。" },
};

export function PageHead({ title, en, subtitle }) {
  return (
    <div className="page-head">
      <h1 className="section-title">
        <span className="section-title-zh">{title}</span>
        {en && <span className="section-title-en">{en}</span>}
      </h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

export const Pending = () => <p className="pending">筹备中</p>;

export function Text({ children }) {
  return (
    <div className="prose">
      {String(children || "")
        .split("\n\n")
        .map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
    </div>
  );
}

function AboutPage({ profile: p }) {
  const interests = p.interests || [];
  const timeline = p.timeline || [];
  return (
    <div className="page">
      <PageHead {...pageHeads.about} />
      <div className={`about-layout${p.portrait ? "" : " is-single"}`}>
        {p.portrait && (
          <img className="about-portrait" src={p.portrait} alt={p.name} />
        )}
        {p.bio ? <Text>{p.bio}</Text> : <Pending />}
      </div>
      <section className="subsection">
        <BlockTitle zh="资料" en="Profile" />
        <ProfileFields profile={p} hideField={hiddenProfileField} />
      </section>
      <section className="subsection">
        <BlockTitle zh="最近在关注" en="Now" />
        {interests.length ? (
          <div className="interest-grid">
            {interests.map((item, index) => (
              <div key={index}>
                <span className="now-status meta">{item.status}</span>
                <h3>{item.title}</h3>
                {withoutPlaceholder(item.text) && (
                  <p>{withoutPlaceholder(item.text)}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Pending />
        )}
      </section>
      <section className="subsection">
        <BlockTitle zh="一些经历" en="Timeline" />
        {timeline.length ? (
          timeline.map((item, index) => (
            <div className="timeline" key={index}>
              <span className="meta">{item.date}</span>
              <div>
                <h3>{item.title}</h3>
                {withoutPlaceholder(item.text) && (
                  <p>{withoutPlaceholder(item.text)}</p>
                )}
              </div>
            </div>
          ))
        ) : (
          <Pending />
        )}
      </section>
    </div>
  );
}

function ProjectsPage({ projects }) {
  const works = worksFrom(projects);
  const categories = workCategories(works);
  const [category, setCategory] = useState("");
  const visible = category
    ? works.filter((work) => work.category === category)
    : works;
  return (
    <>
      <div className="page page-tight">
        <PageHead {...pageHeads.projects} />
        {categories.length > 1 && (
          <SegmentedControl
            label="按分类筛选作品"
            value={category}
            onChange={setCategory}
            options={[
              { value: "", label: "全部" },
              ...categories.map((value) => ({ value, label: value })),
            ]}
          />
        )}
      </div>
      <section className="dark-band" aria-label="作品列表">
        <div className="dark-band-inner">
          <WorkList works={visible} featured={category ? 0 : 2} />
        </div>
      </section>
    </>
  );
}

function NotesPage({ posts }) {
  const sorted = byNewest(posts, "posts");
  return (
    <div className="page">
      <PageHead {...pageHeads.notes} />
      {sorted.length ? (
        <HoverPreview className="notes-list">
          {sorted.map((post) => (
            <NoteRow post={post} key={post.id} />
          ))}
        </HoverPreview>
      ) : (
        <Pending />
      )}
    </div>
  );
}

function WorldPage({ stories }) {
  return (
    <div className="page">
      <PageHead {...pageHeads.world} />
      <ModuleBoundary label="世界地图">
        <Suspense fallback={<PageBodySkeleton page="world" />}>
          <World stories={stories} />
        </Suspense>
      </ModuleBoundary>
    </div>
  );
}

function YouPage({ surveys }) {
  return (
    <div className="page">
      <PageHead {...pageHeads.you} />
      {surveys.length ? (
        <div className="survey-list">
          {surveys.map((survey) => (
            <a className="survey-card" key={survey.id} href={surveyVisitUrl(survey.id)}>
              <span className="meta">
                {surveyState(survey)} · {survey.questionCount} 个问题
              </span>
              <h2>{survey.title}</h2>
              {survey.description && <p>{survey.description}</p>}
              <span className="work-action">
                打开问卷 <ArrowRight aria-hidden="true" />
              </span>
            </a>
          ))}
        </div>
      ) : (
        <Pending />
      )}
      <p className="page-aside">
        <a className="text-link" href="/?page=us">
          也可以写一封信
        </a>
      </p>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page not-found">
      <h1 className="section-title">
        <span className="section-title-zh">这一页还不存在</span>
        <span className="section-title-en">Not found</span>
      </h1>
      <a className="text-link" href="/">
        回到首页
      </a>
    </div>
  );
}

export function PublicPage({ page, data }) {
  if (page === "about") return <AboutPage profile={data.profile} />;
  if (page === "projects") return <ProjectsPage projects={data.projects} />;
  if (page === "notes") return <NotesPage posts={data.posts} />;
  if (page === "world") return <WorldPage stories={data.stories} />;
  if (page === "you") return <YouPage surveys={data.surveys} />;
  return <NotFoundPage />;
}
