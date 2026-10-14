import { publicContent } from "./content.js";

// Card/map data is projected after privacy filtering. Body documents and complete
// albums are retrieved only when a visitor opens the corresponding article.
export function publicSummary(record, kind) {
  const live = publicContent(record, kind);
  const keys = ["id", "title", "category", "status", "date", "createdAt", "publishedAt", "cover", "location", "city", "lat", "lng", "cityLat", "cityLng", "locationPrecision"];
  return {
    ...Object.fromEntries(keys.filter((key) => Object.hasOwn(live, key)).map((key) => [key, live[key]])),
    excerpt: (live.excerpt || live.body || "").slice(0, 180),
    photos: Array.isArray(live.photos) ? live.photos.slice(0, 1) : [],
  };
}
