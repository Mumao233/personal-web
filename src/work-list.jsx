import React from "react";
import { ArrowRight } from "@phosphor-icons/react";
import HoverPreview from "./hover-preview.jsx";
import { sharedLinkProps } from "./view-transition.js";

function WorkArt({ work }) {
  if (work.cover)
    return (
      <span className="work-feature-media">
        <img src={work.cover} alt="" loading="lazy" data-vt-element />
      </span>
    );
  if (work.art === "planet")
    return (
      <span className="work-feature-media work-art-planet" aria-hidden="true">
        <span className="planet" />
      </span>
    );
  if (work.art === "grid")
    return (
      <span className="work-feature-media work-art-grid" aria-hidden="true">
        <span className="grid-art">
          {Array.from({ length: 9 }, (_, index) => (
            <span key={index} />
          ))}
        </span>
      </span>
    );
  return <span className="work-feature-media" aria-hidden="true" />;
}

const number = (index) => String(index + 1).padStart(2, "0");
const external = (work) =>
  !work.builtIn && work.cover
    ? sharedLinkProps("projects", work.id, "media", work)
    : {};

function WorkFeature({ work, index }) {
  return (
    <a
      className={`work-feature${index % 2 ? " is-reversed" : ""}`}
      href={work.href}
      {...external(work)}
    >
      <span className="work-feature-copy">
        <span className="work-meta meta">
          <span>{number(index)}</span>
          {work.meta && <span>{work.meta}</span>}
          {work.status && <span>{work.status}</span>}
        </span>
        <span className="work-feature-title">{work.title}</span>
        {work.excerpt && <span className="work-feature-text">{work.excerpt}</span>}
        {work.action && (
          <span className="work-action">
            {work.action} <ArrowRight aria-hidden="true" />
          </span>
        )}
      </span>
      <WorkArt work={work} />
    </a>
  );
}

function WorkRow({ work, index }) {
  return (
    <a
      className="work-row"
      href={work.href}
      data-preview={work.cover || undefined}
    >
      <span className="work-row-number meta">{number(index)}</span>
      <span className="work-row-title">{work.title}</span>
      <span className="work-row-text">{work.excerpt}</span>
      <span className="work-row-meta meta">{work.meta}</span>
      {work.cover && (
        <img className="row-thumb" src={work.cover} alt="" loading="lazy" />
      )}
    </a>
  );
}

export default function WorkList({ works, featured = 2 }) {
  const rows = works.slice(featured);
  return (
    <>
      {works.slice(0, featured).map((work, index) => (
        <WorkFeature work={work} index={index} key={work.id} />
      ))}
      {rows.length > 0 && (
        <HoverPreview className="work-rows">
          {rows.map((work, index) => (
            <WorkRow work={work} index={index + featured} key={work.id} />
          ))}
        </HoverPreview>
      )}
    </>
  );
}
