import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const CAPABLE = "(hover: hover) and (pointer: fine)";
const REDUCED = "(prefers-reduced-motion: reduce)";
const EASE = 0.18;
const WIDTH = 320;
const OFFSET = 24;

const media = (query) => globalThis.matchMedia?.(query).matches ?? false;

// Wrap a list; rows with data-preview show that image beside the pointer.
export default function HoverPreview({ children, className = "" }) {
  const wrapper = useRef(null);
  const image = useRef(null);
  const [source, setSource] = useState("");
  const [visible, setVisible] = useState(false);
  const paintRef = useRef(() => {});
  // The first hover mounts the image after the pointer position is already known.
  useLayoutEffect(() => paintRef.current(), [source]);
  useEffect(() => {
    if (!media(CAPABLE) || !wrapper.current) return undefined;
    const node = wrapper.current;
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let frame = 0;
    let started = false;
    const paint = () => {
      if (image.current)
        image.current.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`;
    };
    paintRef.current = paint;
    const tick = () => {
      current.x += (target.x - current.x) * EASE;
      current.y += (target.y - current.y) * EASE;
      paint();
      frame =
        Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > 0.3
          ? requestAnimationFrame(tick)
          : 0;
    };
    const move = (event) => {
      const height = image.current?.offsetHeight || WIDTH * 0.625;
      target.x = Math.min(event.clientX + OFFSET, window.innerWidth - WIDTH - 16);
      target.y = Math.max(
        16,
        Math.min(event.clientY - height / 2, window.innerHeight - height - 16),
      );
      if (!started || media(REDUCED)) {
        started = true;
        current.x = target.x;
        current.y = target.y;
        paint();
      } else if (!frame) frame = requestAnimationFrame(tick);
    };
    const over = (event) => {
      const row = event.target.closest?.("[data-preview]");
      if (row && node.contains(row)) {
        move(event);
        // Decoding ahead avoids showing a half-painted image in the fade.
        new Image().src = row.dataset.preview;
        setSource(row.dataset.preview);
        setVisible(true);
      } else {
        setVisible(false);
        started = false;
      }
    };
    const leave = () => {
      setVisible(false);
      started = false;
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerover", over);
    node.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerover", over);
      node.removeEventListener("pointerleave", leave);
    };
  }, []);
  return (
    <div ref={wrapper} className={className}>
      {children}
      {source && (
        <img
          ref={image}
          className={`hover-preview${visible ? " is-visible" : ""}`}
          src={source}
          alt=""
          aria-hidden="true"
          width={WIDTH}
        />
      )}
    </div>
  );
}
