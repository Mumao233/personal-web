import React from "react";

export const SkeletonLine = ({ width = "100%", height = 16, className = "" }) => (
  <span
    className={`skeleton ${className}`}
    style={{ width, height }}
    aria-hidden="true"
  />
);

export const IntroSkeleton = () => (
  <div className="intro-copy-text">
    <SkeletonLine className="on-dark" />
    <SkeletonLine className="on-dark" />
    <SkeletonLine className="on-dark" width="62%" />
  </div>
);

export function RowsSkeleton({ rows = 3, dark = false }) {
  return (
    <div className="skeleton-rows">
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <SkeletonLine className={dark ? "on-dark" : ""} width={72} height={12} />
          <SkeletonLine
            className={dark ? "on-dark" : ""}
            width="min(420px, 70%)"
            height={26}
          />
          <SkeletonLine className={dark ? "on-dark" : ""} width="86%" />
        </div>
      ))}
    </div>
  );
}

export function WorkSkeleton() {
  return (
    <>
      {[0, 1].map((index) => (
        <div
          className={`work-feature${index % 2 ? " is-reversed" : ""}`}
          key={index}
        >
          <div className="work-feature-copy">
            <SkeletonLine className="on-dark" width={140} height={12} />
            <SkeletonLine className="on-dark" width="80%" height={40} />
            <SkeletonLine className="on-dark" />
            <SkeletonLine className="on-dark" width="70%" />
          </div>
          <span className="work-feature-media skeleton on-dark" aria-hidden="true" />
        </div>
      ))}
      <RowsSkeleton dark rows={2} />
    </>
  );
}

export function NotesSkeleton() {
  return (
    <div className="notes-latest">
      <RowsSkeleton rows={2} />
    </div>
  );
}

export function ArticleBodySkeleton() {
  return (
    <div className="article-body-skeleton" aria-hidden="true">
      {["100%", "100%", "92%", "100%", "68%"].map((width, index) => (
        <SkeletonLine key={index} width={width} height={19} />
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="detail-skeleton" aria-hidden="true">
      <div className="detail-skeleton-head">
        <SkeletonLine width={120} height={18} />
        <SkeletonLine width="min(620px, 90%)" height={64} />
        <SkeletonLine width={140} height={12} />
      </div>
      <span className="skeleton detail-skeleton-cover" />
      <ArticleBodySkeleton />
    </div>
  );
}

export function PageBodySkeleton({ page }) {
  if (page === "about")
    return (
      <div className="about-layout">
        <span className="about-portrait skeleton" aria-hidden="true" />
        <div className="skeleton-rows">
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine width="74%" />
        </div>
      </div>
    );
  if (page === "world")
    return <span className="skeleton world-skeleton" aria-hidden="true" />;
  return <RowsSkeleton rows={4} />;
}
