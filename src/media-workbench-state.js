import { isCalendarDate } from "../shared/content-date.js";

const coordinateValue = (value, maximum) =>
  ["number", "string"].includes(typeof value) &&
  !(typeof value === "string" && !value.trim()) &&
  Number.isFinite(Number(value)) &&
  Math.abs(Number(value)) <= maximum;
export const validCoordinates = (lat, lng) =>
  coordinateValue(lat, 90) && coordinateValue(lng, 180);
export function moveItem(items, index, direction) {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const result = [...items];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}
export function exifDate(value) {
  let candidate = "";
  if (value instanceof Date && Number.isFinite(value.getTime()))
    candidate = [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, i) => String(part).padStart(i ? 2 : 4, "0"))
      .join("-");
  else if (typeof value === "string")
    candidate = value.slice(0, 10).replaceAll(":", "-");
  return isCalendarDate(candidate) ? candidate : "";
}
export async function readPhotoMetadata(file) {
  const module = await import("exifr");
  const exifr = module.default || module;
  const result = await exifr
    .parse(file, {
      pick: [
        "DateTimeOriginal",
        "CreateDate",
        "GPSLatitude",
        "GPSLongitude",
        "GPSLatitudeRef",
        "GPSLongitudeRef",
      ],
      gps: true,
    })
    .catch(() => null);
  const takenAt = exifDate(result?.DateTimeOriginal || result?.CreateDate);
  let gps =
    result && validCoordinates(result.latitude, result.longitude)
      ? { lat: result.latitude, lng: result.longitude }
      : null;
  if (!gps) {
    const values = await exifr.gps(file).catch(() => null);
    if (values && validCoordinates(values.latitude, values.longitude))
      gps = { lat: values.latitude, lng: values.longitude };
  }
  return { takenAt, ...(gps || {}) };
}
export function appendUploadedPhoto(
  value,
  job,
  src,
  { isNew = false, useGps = false, sameDate = "" } = {},
) {
  const detail = {
    src,
    alt: job.alt || "",
    caption: job.caption || "",
    takenAt: job.takenAt || "",
    ...(validCoordinates(job.lat, job.lng)
      ? { lat: Number(job.lat), lng: Number(job.lng) }
      : {}),
  };
  const next = {
    ...value,
    photos: [...(value.photos || []), src],
    photoDetails: [...(value.photoDetails || []), detail],
  };
  if (isNew && !value.date && value.dateMode !== "manual" && sameDate)
    next.date = sameDate;
  // Only an explicit choice attached to this successfully uploaded item applies
  // GPS. Merely reading metadata never changes the story or invokes geocoding.
  if (useGps && validCoordinates(job.lat, job.lng))
    Object.assign(next, {
      lat: Number(job.lat),
      lng: Number(job.lng),
      confirmLocation: false,
    });
  return next;
}
export function storyPublicationProblem(value) {
  const precision = value.locationPrecision || "exact";
  if (precision === "hidden") return "";
  if (precision === "city") {
    if (!validCoordinates(value.cityLat, value.cityLng))
      return "城市级公开需要单独选择有效的城市代表点。";
    if (!value.publicLocation?.trim()) return "请填写将展示给访客的公开地名。";
    if (!value.confirmLocation) return "请确认这个城市名称与代表位置可以公开。";
    return "";
  }
  if (!validCoordinates(value.lat, value.lng))
    return "精确位置公开需要有效的经纬度。";
  if (!value.confirmLocation) return "请确认这个精确位置可以公开。";
  return "";
}
