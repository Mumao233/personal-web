import { sessionState } from "./browser-state.js";

const KEY = "shared-element-handoff";
const MAX_AGE = 15000;

// Marks a link whose descendant [data-vt-element] morphs into the next page.
export const sharedLinkProps = (collection, id, part, item) => ({
  "data-vt-collection": collection,
  "data-vt-id": id,
  "data-vt-part": part,
  "data-vt-title": item.title || "",
  "data-vt-cover": item.cover || "",
});

const named = () =>
  document.querySelectorAll("[data-vt-element], .vt-shared-target");

export function handleSharedClick(event) {
  if (
    event.defaultPrevented ||
    event.button ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  // Only the element that was clicked may carry a name when the page is captured.
  named().forEach((node) => {
    node.style.viewTransitionName = "";
  });
  const link = event.target.closest?.("a[data-vt-part]");
  if (!link || link.target) return;
  const element = link.querySelector("[data-vt-element]");
  if (!element) return;
  const { vtCollection, vtId, vtPart, vtTitle, vtCover } = link.dataset;
  element.style.viewTransitionName = `shared-${vtPart}`;
  sessionState.setItem(
    KEY,
    JSON.stringify({
      collection: vtCollection,
      id: vtId,
      part: vtPart,
      title: vtTitle,
      cover: vtCover,
      at: Date.now(),
    }),
  );
}

// Consumed once, so a later reload or back navigation renders the page normally.
export function takeSharedHandoff(route) {
  const raw = sessionState.getItem(KEY);
  sessionState.removeItem(KEY);
  if (!raw || !route.collection) return null;
  try {
    const handoff = JSON.parse(raw);
    return handoff.collection === route.collection &&
      handoff.id === route.id &&
      Date.now() - handoff.at < MAX_AGE
      ? handoff
      : null;
  } catch {
    return null;
  }
}

export function installSharedTransitions() {
  if (document.documentElement.dataset.surface === "admin") {
    window.addEventListener("pagereveal", (event) =>
      event.viewTransition?.skipTransition(),
    );
    return;
  }
  document.addEventListener("click", handleSharedClick);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted)
      named().forEach((node) => {
        node.style.viewTransitionName = "";
      });
  });
}

export const sharedStyle = (shared, part) =>
  shared === part ? { viewTransitionName: `shared-${part}` } : undefined;
