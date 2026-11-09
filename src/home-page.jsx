import React from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { contentDateValue } from "../shared/content-date.js";
import { surveyVisitUrl } from "../shared/page-info.js";
import { hero, notesQuote, threads } from "./home-content.js";
import {
  byNewest,
  dotDate,
  openSurveys,
  storyImage,
  worksFrom,
} from "./public-format.js";
import {
  IntroSkeleton,
  NotesSkeleton,
  RowsSkeleton,
  WorkSkeleton,
} from "./skeleton.jsx";
import { sharedLinkProps } from "./view-transition.js";
import WorkList from "./work-list.jsx";

const variants = (extension) =>
  [1280, 2560]
    .map((width) => `${hero.photo.basePath}-${width}.${extension} ${width}w`)
    .join(", ");
// The image never gets narrower than its 460px min-height allows, so phones need
// more pixels than their viewport width suggests.
const photoSizes = "max(100vw, 1074px)";

export function HeroPhoto() {
  const { photo } = hero;
  return (
    <figure className="hero-photo">
      <picture>
        <source type="image/avif" srcSet={variants("avif")} sizes={photoSizes} />
        <source type="image/webp" srcSet={variants("webp")} sizes={photoSizes} />
        <img
          src={`${photo.basePath}-1280.jpg`}
          srcSet={variants("jpg")}
          sizes={photoSizes}
          width={photo.width}
          height={photo.height}
          alt={photo.alt}
          loading="eager"
          fetchPriority="high"
        />
      </picture>
      <figcaption className="meta">
        {[photo.place, photo.takenAt].filter(Boolean).join(" · ")}
      </figcaption>
    </figure>
  );
}

function SectionTitle({ id, zh, en, inline = false }) {
  return (
    <h2 id={id} className={`section-title${inline ? " is-inline" : ""}`}>
      <span className="section-title-zh">{zh}</span>
      <span className="section-title-en">{en}</span>
    </h2>
  );
}

export function BlockTitle({ id, zh, en }) {
  return (
    <h2 id={id} className="block-title">
      <span className="block-title-zh">{zh}</span>
      <span className="block-title-en">{en}</span>
    </h2>
  );
}

function Threads() {
  return (
    <section id="threads" aria-labelledby="threads-title" className="band threads">
      <BlockTitle id="threads-title" zh="三条线" en="Three threads" />
      <div className="threads-grid">
        {threads.map((thread) => (
          <div className="thread" key={thread.numeral}>
            <span className="thread-numeral">{thread.numeral}</span>
            <h3 className="thread-title">
              <span>{thread.title}</span>
              <span className="thread-en">{thread.en}</span>
            </h3>
            <p className="thread-body is-full">{thread.body}</p>
            <p className="thread-body is-short">{thread.bodyShort}</p>
            <ul className="thread-items">
              {thread.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Work({ data }) {
  return (
    <section id="work" aria-labelledby="work-title" className="dark-band">
      <div className="dark-band-inner">
        <SectionTitle id="work-title" zh="作品" en="Selected work, 2023 — now" />
        {data ? <WorkList works={worksFrom(data.projects)} /> : <WorkSkeleton />}
      </div>
    </section>
  );
}

const photoShapes = ["is-wide", "is-tall", "is-square"];

function Photos({ stories }) {
  const items = stories.filter(storyImage).slice(0, 3);
  if (!items.length) return null;
  return (
    <section id="photos" aria-labelledby="photos-title" className="band photos">
      <SectionTitle id="photos-title" zh="影像" en="Dusk, mostly." />
      <div className="photos-grid">
        {items.map((story, index) => (
          <a
            key={story.id}
            className={`photo-tile ${photoShapes[index]}`}
            href={`/?page=world&story=${encodeURIComponent(story.id)}`}
            {...sharedLinkProps("stories", story.id, "media", story)}
          >
            <span className="photo-tile-image">
              <img src={storyImage(story)} alt={story.title || ""} loading="lazy" data-vt-element />
            </span>
            <span className="photo-tile-caption meta">
              <span>{story.location || story.city || story.title}</span>
              <span>{dotDate(contentDateValue(story, "stories")).slice(0, 4)}</span>
            </span>
          </a>
        ))}
      </div>
      <a className="text-link" href="/?page=world">
        全部影像
      </a>
    </section>
  );
}

export function NoteRow({ post, excerpt = true }) {
  return (
    <a
      className="note-row"
      href={`/?page=notes&post=${encodeURIComponent(post.id)}`}
      data-preview={post.cover || undefined}
      {...sharedLinkProps("posts", post.id, "title", post)}
    >
      <span className="meta">{dotDate(contentDateValue(post, "posts"))}</span>
      <span className="note-row-title" data-vt-element>
        {post.title}
      </span>
      {excerpt && post.excerpt && (
        <span className="note-row-text">{post.excerpt}</span>
      )}
      {post.cover && (
        <img className="row-thumb" src={post.cover} alt="" loading="lazy" />
      )}
    </a>
  );
}

function Notes({ data }) {
  const posts = data ? byNewest(data.posts, "posts").slice(0, 2) : [];
  return (
    <section id="notes" aria-labelledby="notes-title" className="band notes">
      <div className="notes-side">
        <SectionTitle id="notes-title" zh="随笔" en="Notes" inline />
        <blockquote className="notes-quote">
          <p>{notesQuote.text}</p>
          <footer>{notesQuote.source}</footer>
        </blockquote>
      </div>
      {!data ? (
        <NotesSkeleton />
      ) : posts.length ? (
        <div className="notes-latest">
          {posts.map((post) => (
            <NoteRow post={post} key={post.id} />
          ))}
        </div>
      ) : (
        <div className="notes-latest">
          <p className="pending">筹备中</p>
        </div>
      )}
    </section>
  );
}

function Now({ data }) {
  const items = (data?.profile.interests || []).slice(0, 3);
  return (
    <div className="talk-column">
      <BlockTitle zh="此刻" en="Now" />
      {!data ? (
        <RowsSkeleton rows={3} />
      ) : items.length ? (
        <div>
          {items.map((item, index) => (
            <div className="now-row" key={index}>
              <span className="now-status meta">{item.status}</span>
              <span>{item.title}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="pending">筹备中</p>
      )}
    </div>
  );
}

function Conversation({ data }) {
  const surveys = data ? openSurveys(data.surveys) : [];
  return (
    <div className="talk-column">
      <BlockTitle zh="对话" en="Conversation" />
      <p className="talk-text">
        {surveys.length > 0 && `有 ${surveys.length} 份问卷正在开放，想听听你的答案。`}
        也可以直接写一封信给我，公开或者私密都行。
      </p>
      {!data ? (
        <RowsSkeleton rows={2} />
      ) : (
        surveys.length > 0 && (
          <div>
            {surveys.map((survey) => (
              <a className="talk-row" href={surveyVisitUrl(survey.id)} key={survey.id}>
                <span>{survey.title}</span>
                <span className="meta">{survey.questionCount} 题</span>
              </a>
            ))}
          </div>
        )
      )}
      <a className="button talk-letter" href="/?page=us">
        写一封信 <ArrowRight aria-hidden="true" />
      </a>
    </div>
  );
}

export default function HomePage({ data }) {
  const latest = data ? byNewest(data.posts, "posts")[0] : null;
  return (
    <>
      <div className="hero-band">
        <section className="hero-copy">
          <div className="hero-kicker meta">
            {hero.kicker.map((part) => (
              <span key={part}>{part}</span>
            ))}
          </div>
          <h1 className="hero-title">
            {hero.titleLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </h1>
          <p className="hero-subtitle">{hero.subtitle}</p>
        </section>
        <HeroPhoto />
        <section className="hero-intro" aria-label="自我介绍">
          <div className="hero-intro-inner">
            {data ? (
              <p className="intro-copy-text">{data.profile.intro}</p>
            ) : (
              <IntroSkeleton />
            )}
            <div className="hero-actions">
              <a className="button is-light" href="#work">
                看看作品 <ArrowRight aria-hidden="true" />
              </a>
              <a
                className="text-link is-light"
                href={
                  latest
                    ? `/?page=notes&post=${encodeURIComponent(latest.id)}`
                    : "/?page=notes"
                }
              >
                读一篇随笔
              </a>
            </div>
          </div>
        </section>
      </div>
      <Threads />
      <Work data={data} />
      {data && <Photos stories={data.stories} />}
      <Notes data={data} />
      <section id="talk" className="band talk">
        <Now data={data} />
        <Conversation data={data} />
      </section>
    </>
  );
}
