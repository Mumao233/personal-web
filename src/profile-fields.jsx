import React from "react";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { getProfileFields, profileFieldHref } from "../server/profile.js";
import "./profile-fields.css";

export function ProfileFieldsEditor({ profile, onChange }) {
  const fields = getProfileFields(profile);
  function update(id, patch) {
    const field = fields.find((entry) => entry.id === id);
    onChange({
      ...profile,
      ...(field.key && patch.value !== undefined
        ? { [field.key]: patch.value }
        : {}),
      fields: fields.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    });
  }
  function move(index, direction) {
    const next = [...fields];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    onChange({ ...profile, fields: next });
  }
  return (
    <section className="profile-fields-editor" aria-label="个人资料栏目">
      <div>
        <h2>个人资料栏目</h2>
        <p className="fine">
          添加你想公开的资料和链接，用箭头调整展示顺序。未填写或关闭展示的栏目不会出现在网站。姓名仍用于网站开场。
        </p>
      </div>
      {fields.map((field, index) => (
        <section
          className="profile-field-editor"
          key={field.id}
          aria-label={`栏目：${field.label || "未命名"}`}
        >
          <div className="profile-field-head">
            <span className="eyebrow">
              {String(index + 1).padStart(2, "0")} /{" "}
              {field.key ? "基本资料" : "自定义栏目"}
            </span>
            <div>
              <button
                type="button"
                disabled={index === 0}
                aria-label={`上移栏目 ${field.label}`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </button>
              <button
                type="button"
                disabled={index === fields.length - 1}
                aria-label={`下移栏目 ${field.label}`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </button>
              {!field.key && (
                <button
                  type="button"
                  className="danger"
                  aria-label={`删除栏目 ${field.label}`}
                  onClick={() =>
                    onChange({
                      ...profile,
                      fields: fields.filter((entry) => entry.id !== field.id),
                    })
                  }
                >
                  <Trash />
                </button>
              )}
            </div>
          </div>
          <div className="profile-field-inputs">
            <label>
              栏目名称
              <input
                value={field.label}
                maxLength={60}
                required
                onChange={(event) =>
                  update(field.id, { label: event.target.value })
                }
              />
            </label>
            <label>
              显示内容
              <input
                value={field.value}
                maxLength={500}
                required={field.key === "name"}
                type={
                  field.key === "email"
                    ? "email"
                    : field.key === "github"
                      ? "url"
                      : "text"
                }
                onChange={(event) =>
                  update(field.id, { value: event.target.value })
                }
              />
            </label>
            <label>
              超链接（可选）
              <input
                value={field.href || ""}
                maxLength={2000}
                placeholder="https://… 或 /站内路径"
                onChange={(event) =>
                  update(field.id, { href: event.target.value })
                }
              />
            </label>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={field.visible !== false}
              onChange={(event) =>
                update(field.id, { visible: event.target.checked })
              }
            />
            在网站展示
          </label>
          {["email", "phone", "github"].includes(field.key) && (
            <p className="fine">
              不填写超链接时，自动使用
              {field.key === "email"
                ? "邮件链接"
                : field.key === "phone"
                  ? "电话链接"
                  : "上方主页地址"}
              。
            </p>
          )}
        </section>
      ))}
      <button
        type="button"
        className="quiet"
        disabled={fields.length >= 30}
        onClick={() =>
          onChange({
            ...profile,
            fields: [
              ...fields,
              {
                id: crypto.randomUUID(),
                key: "",
                label: "",
                value: "",
                href: "",
                visible: true,
              },
            ],
          })
        }
      >
        <Plus />
        添加自定义栏目
      </button>
    </section>
  );
}

export function ProfileFields({ profile }) {
  const fields = getProfileFields(profile).filter(
    (field) => field.visible !== false && String(field.value).trim(),
  );
  if (!fields.length)
    return <p className="fine">可以在「关于我们」里给我留言。</p>;
  return (
    <dl className="profile-public-fields">
      {fields.map((field) => {
        const href = profileFieldHref(field);
        const external = /^https?:/i.test(href);
        return (
          <div key={field.id}>
            <dt>{field.label}</dt>
            <dd>
              {href ? (
                <a
                  href={href}
                  target={external ? "_blank" : undefined}
                  rel={external ? "noopener noreferrer" : undefined}
                >
                  {field.value}
                  {external && <ArrowUpRight aria-hidden="true" />}
                </a>
              ) : (
                <span>{field.value}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
