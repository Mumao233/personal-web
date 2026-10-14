// Calendar dates are authored dates, not instants. Never pass them through a
// local timezone; timestamps use the site's explicit Shanghai timezone.
export function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

export function calendarDateAt(value) {
  if (isCalendarDate(value)) return value;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return "";
  if (!isCalendarDate(value.slice(0, 10))) return "";
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (kind) => parts.find((part) => part.type === kind)?.value;
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

export function formatContentDate(value) {
  return calendarDateAt(value).replaceAll("-", "/");
}

export function contentDateValue(item, kind) {
  if (!item) return "";
  if (item.date) return item.date;
  if (kind === "story" || kind === "stories") return "";
  return item.publishedAt || item.createdAt || "";
}
