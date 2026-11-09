import {
  calendarDateAt,
  contentDateValue,
  formatContentDate,
} from "../shared/content-date.js";
import { builtInWorks } from "./home-content.js";

export const dotDate = (value) => formatContentDate(value).replaceAll("/", ".");

export function byNewest(items, kind) {
  return [...items].sort((a, b) =>
    calendarDateAt(contentDateValue(b, kind)).localeCompare(
      calendarDateAt(contentDateValue(a, kind)),
    ),
  );
}

export function surveyState(survey, now = Date.now()) {
  if (survey.closed) return "已关闭";
  if (survey.startsAt && now < Date.parse(survey.startsAt)) return "尚未开始";
  if (survey.endsAt && now > Date.parse(survey.endsAt)) return "已结束";
  return "开放填写";
}

export const openSurveys = (surveys = []) =>
  surveys.filter((survey) => surveyState(survey) === "开放填写");

export const storyImage = (story) => story.cover || story.photos?.[0] || "";

// Design order: first project, the Atlas, Nine Grid, then remaining projects.
export function worksFrom(projects = []) {
  const [first, ...rest] = projects.map((project) => ({
    ...project,
    excerpt: withoutPlaceholder(project.excerpt),
    href: `/?page=projects&project=${encodeURIComponent(project.id)}`,
    meta: [
      dotDate(contentDateValue(project, "projects")),
      project.category,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  return [
    ...(first ? [first] : []),
    builtInWorks.solar,
    builtInWorks.nineGrid,
    ...rest,
  ];
}

export function workCategories(works) {
  return [...new Set(works.map((work) => work.category).filter(Boolean))];
}

export const hiddenProfileField = (field) =>
  field.key === "phone" || /电话|手机|生日|出生/.test(field.label || "");

export const withoutPlaceholder = (text) =>
  /待补充/.test(text || "") ? "" : text || "";
