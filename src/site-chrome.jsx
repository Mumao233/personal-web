import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { List as MenuIcon, X } from "@phosphor-icons/react";
import { dismissFromPointer } from "./theme-state.js";
import { footerContent } from "./home-content.js";

export const siteNav = [
  ["projects", "作品"],
  ["notes", "随笔"],
  ["world", "影像"],
  ["about", "关于"],
  ["us", "对话"],
];

const isCurrent = (page, key) =>
  page === key || (key === "us" && page === "you");

export function SiteHeader({ page, name, dark = false, visitSequence }) {
  const [menu, setMenu] = useState(false);
  const toggle = useRef(null);
  const panel = useRef(null);
  const backdropPointer = useRef(null);
  const closeMenu = () => {
    setMenu(false);
    toggle.current?.focus({ preventScroll: true });
  };
  useEffect(() => setMenu(false), [visitSequence]);
  useEffect(() => {
    if (!menu) return undefined;
    const drawer = panel.current;
    if (drawer) {
      drawer.scrollTop = 0;
      drawer.querySelector("button, a[href]")?.focus({ preventScroll: true });
    }
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
      if (event.key === "Tab" && drawer) {
        const items = [
          ...drawer.querySelectorAll("a[href],button:not([disabled])"),
        ];
        const at = items.indexOf(document.activeElement);
        // This drawer is non-modal: leaving either end closes it and returns to
        // its opener. No focus trap, inert background or document scroll lock.
        if (
          (event.shiftKey && at <= 0) ||
          (!event.shiftKey && at === items.length - 1)
        ) {
          event.preventDefault();
          closeMenu();
        }
      }
    };
    const desktop = matchMedia("(min-width: 760px)");
    const closeOnDesktop = (event) => {
      if (event.matches) setMenu(false);
    };
    document.addEventListener("keydown", onKeyDown);
    desktop.addEventListener?.("change", closeOnDesktop);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      desktop.removeEventListener?.("change", closeOnDesktop);
    };
  }, [menu]);
  return (
    <header className={`header${dark ? " is-dark" : ""}`}>
      <div className="header-inner">
        <a className="wordmark" href="/">
          <span className="wordmark-zh">{name}</span>
          <span className="wordmark-en">{footerContent.name}</span>
        </a>
        <button
          ref={toggle}
          type="button"
          className="menu-toggle"
          aria-label={menu ? "关闭导航" : "打开导航"}
          aria-expanded={menu}
          aria-controls="mobile-navigation"
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X size={18} /> : <MenuIcon size={18} />}
        </button>
        <nav aria-label="主要导航" className="desktop-navigation">
          {siteNav.map(([key, label]) => (
            <a
              className={isCurrent(page, key) ? "active" : ""}
              aria-current={isCurrent(page, key) ? "page" : undefined}
              key={key}
              href={"/?page=" + key}
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
      {createPortal(
        <div className={`mobile-menu-layer ${menu ? "open" : ""}`}>
          <div
            className={`menu-backdrop ${menu ? "open" : ""}`}
            aria-hidden="true"
            onPointerDown={(event) => {
              backdropPointer.current = {
                clientX: event.clientX,
                clientY: event.clientY,
              };
            }}
            onPointerUp={(event) => {
              if (dismissFromPointer(backdropPointer.current, event))
                closeMenu();
              backdropPointer.current = null;
            }}
            onPointerCancel={() => {
              backdropPointer.current = null;
            }}
            onClick={(event) => {
              if (event.detail === 0) closeMenu();
            }}
          />
          <nav
            ref={panel}
            id="mobile-navigation"
            aria-label="手机导航"
            inert={!menu ? true : undefined}
            aria-hidden={!menu}
            className={`mobile-navigation ${menu ? "open" : ""}`}
          >
            <div className="mobile-menu-top">
              <button
                type="button"
                className="menu-close"
                aria-label="关闭导航"
                onClick={closeMenu}
              >
                <X size={18} />
              </button>
            </div>
            {siteNav.map(([key, label]) => (
              <a
                className={isCurrent(page, key) ? "active" : ""}
                aria-current={isCurrent(page, key) ? "page" : undefined}
                key={key}
                href={"/?page=" + key}
                onClick={() => setMenu(false)}
              >
                {label}
              </a>
            ))}
          </nav>
        </div>,
        document.body,
      )}
    </header>
  );
}

export function SiteFooter({ home }) {
  const year = new Date().getFullYear();
  const legal = `${footerContent.domain} · © ${year} ${footerContent.owner}`;
  if (!home)
    return (
      <footer className="site-footer is-compact">
        <div className="site-footer-inner">
          <span className="footer-name-small">{footerContent.name}</span>
          <span className="meta">{legal}</span>
        </div>
      </footer>
    );
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p className="footer-name">{footerContent.name}</p>
        <div className="footer-columns">
          <div>
            <span className="meta">站内</span>
            <a href="/?page=projects">作品</a>
            <a href="/?page=notes">随笔</a>
            <a href="/?page=world">影像</a>
            <a href="/?page=about">关于</a>
          </div>
          <div>
            <span className="meta">联系</span>
            <a href="/?page=us">写一封信</a>
            <a
              href={footerContent.github}
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
          </div>
        </div>
        <div className="footer-legal meta">
          <span>{footerContent.domain}</span>
          <span>
            © {year} {footerContent.owner}
          </span>
        </div>
      </div>
    </footer>
  );
}
