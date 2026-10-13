import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProfileFields,
  normalizeProfile,
  safeProfileHref,
  profileFieldHref,
  publicProfile,
} from "../server/profile.js";

const old = {
  name: "测试姓名",
  email: "test@example.com",
  phone: "",
  wechat: "",
  github: "",
  intro: "简介原文\n保持不变",
  bio: "自述原文\n\n保持不变",
  interests: [],
  timeline: [],
};
test("legacy profile fields stay editable and ordered custom fields preserve biography", () => {
  const fields = getProfileFields(old);
  const custom = {
    id: "custom-school",
    key: "",
    label: "院校",
    value: "示例大学",
    href: "https://example.com/",
    visible: true,
  };
  const updated = normalizeProfile(old, {
    fields: [custom, ...fields.reverse()],
  });
  assert.equal(getProfileFields(updated)[0].label, "院校");
  assert.equal(getProfileFields(updated).at(-1).key, "name");
  assert.equal(updated.intro, old.intro);
  assert.equal(updated.bio, old.bio);
  assert.equal(updated.email, old.email);
  assert.equal(
    profileFieldHref(fields.find((x) => x.key === "email")),
    "mailto:test@example.com",
  );
});
test("profile hyperlinks reject executable and ambiguous destinations", () => {
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,x",
    "//example.com",
    "/\\example.com",
    "https://example.com\n.evil",
    "file:///private",
  ]) {
    assert.equal(safeProfileHref(href), "", href);
    assert.throws(() =>
      normalizeProfile(old, {
        fields: [{ id: "custom", label: "链接", value: "文字", href }],
      }),
    );
  }
  for (const href of [
    "https://example.com/path?q=1",
    "mailto:test@example.com",
    "tel:+8612345",
    "/?page=projects",
  ])
    assert.equal(safeProfileHref(href), href);
});
test("profile field validation catches duplicate identities, missing labels and unsafe builtin links", () => {
  const base = { id: "first", key: "", label: "栏目", value: "值", href: "" };
  assert.throws(() => normalizeProfile(old, { fields: [base, base] }));
  assert.throws(() =>
    normalizeProfile(old, { fields: [{ ...base, label: "" }] }),
  );
  assert.throws(() =>
    normalizeProfile(old, { fields: [{ ...base, key: "bio" }] }),
  );
  assert.throws(() => normalizeProfile(old, { github: "javascript:alert(1)" }));
  const hidden = normalizeProfile(old, {
    fields: [{ ...base, visible: false }],
  });
  assert.equal(hidden.fields[0].visible, false);
  const publicData = publicProfile(hidden);
  assert.deepEqual(publicData.fields, []);
  assert.equal(publicData.email, "");
  assert.equal(publicData.name, old.name);
});
