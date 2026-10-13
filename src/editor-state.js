export const isRevisionConflict = (error) =>
  error?.status === 409 || error?.code === "REVISION_CONFLICT";

export function localDate(value = new Date()) {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part, index) => String(part).padStart(index ? 2 : 4, "0"))
    .join("-");
}

// Invalidate not only when a new request starts, but also when its input changes.
export function latestRequest() {
  let sequence = 0;
  return {
    next: () => ++sequence,
    isCurrent: (request) => request === sequence,
    invalidate: () => ++sequence,
  };
}
