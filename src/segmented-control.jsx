import React, { useLayoutEffect, useRef } from "react";

// Toggle buttons with a sliding selection. `segmented` and `selected` also keep the
// previous admin styles working where the map picker renders this control.
export default function SegmentedControl({
  label,
  options,
  value,
  onChange,
  className = "",
}) {
  const root = useRef(null);
  const thumb = useRef(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return undefined;
    const place = () => {
      const active = node.querySelector('[aria-pressed="true"]');
      if (!active || !thumb.current) return;
      thumb.current.style.width = `${active.offsetWidth}px`;
      thumb.current.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    place();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, options.length]);
  const onKeyDown = (event) => {
    const step = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    }[event.key];
    const edge = { Home: 0, End: options.length - 1 }[event.key];
    if (step === undefined && edge === undefined) return;
    event.preventDefault();
    const at = options.findIndex((option) => option.value === value);
    const index =
      edge ?? (at + step + options.length) % options.length;
    onChange(options[index].value);
    root.current.querySelectorAll("button")[index]?.focus();
  };
  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      className={`segmented segmented-control ${className}`}
      onKeyDown={onKeyDown}
    >
      <span ref={thumb} className="segmented-thumb" aria-hidden="true" />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            type="button"
            key={option.value}
            className={active ? "selected" : ""}
            aria-pressed={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
