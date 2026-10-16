import React, { useEffect, useRef, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { quotes } from "./quotes";
import { safeStorage, sessionState } from "./browser-state.js";

export const QUOTE_PAUSED_KEY = "personal-space.quote-paused";
const preferences = safeStorage(() => globalThis.localStorage);
export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function Intro() {
  const [show, setShow] = useState(() => !sessionState.getItem("greeted"));
  const [word, setWord] = useState(0);
  const reduced = useReducedMotion();
  const finish = () => setShow(false);
  useEffect(() => {
    if (!show) return;
    // Mark the visit when it starts, so refreshing during the welcome never replays it.
    sessionState.setItem("greeted", "1");
    if (reduced) {
      finish();
      return;
    }
    const interval = setInterval(() => setWord((value) => value + 1), 440);
    const timer = setTimeout(finish, 2600);
    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [show, reduced]);
  return (
    show && (
      <div className="intro" role="dialog" aria-label="欢迎">
        <span className="hello">
          {
            ["Hello", "你好", "Bonjour", "Hola", "こんにちは", "Hello"][
              word % 6
            ]
          }
          <span className="cursor">_</span>
        </span>
        <button onClick={finish}>
          跳过 <ArrowRight />
        </button>
        <span className="intro-caption">A SMALL SPACE IN A BIG WORLD</span>
      </div>
    )
  );
}

export function TypeQuote() {
  const [paused, setPaused] = useState(
    () => preferences.getItem(QUOTE_PAUSED_KEY) === "1",
  );
  const reduced = useReducedMotion();
  const index = useRef(Math.floor(Math.random() * quotes.length));
  const sentenceRef = useRef(quotes[index.current][0]);
  const [sentence, setSentence] = useState(sentenceRef.current);
  const [text, setText] = useState("");
  const visible = useRef("");
  useEffect(() => {
    const sync = (event) => {
      if (event.key === QUOTE_PAUSED_KEY) setPaused(event.newValue === "1");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    let timer,
      disposed = false;
    const display = (value) => {
      visible.current = value;
      setText(value);
    };
    if (paused || reduced) {
      display(sentenceRef.current);
      return;
    }
    const step = () => {
      if (disposed) return;
      if (visible.current.length < sentenceRef.current.length) {
        display(sentenceRef.current.slice(0, visible.current.length + 1));
        timer = setTimeout(
          step,
          /[\u4e00-\u9fff]/.test(sentenceRef.current) ? 95 : 45,
        );
      } else timer = setTimeout(erase, 15000);
    };
    const erase = () => {
      if (disposed) return;
      if (visible.current.length) {
        display(visible.current.slice(0, -1));
        timer = setTimeout(erase, 22);
      } else {
        index.current =
          (index.current +
            1 +
            Math.floor(Math.random() * (quotes.length - 1))) %
          quotes.length;
        sentenceRef.current =
          quotes[index.current][Math.random() < 0.5 ? 0 : 1];
        setSentence(sentenceRef.current);
        timer = setTimeout(step, 400);
      }
    };
    timer = setTimeout(
      step,
      visible.current === sentenceRef.current ? 15000 : 550,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [paused, reduced]);
  const toggle = () => {
    const next = !paused;
    preferences.setItem(QUOTE_PAUSED_KEY, next ? "1" : "0");
    setPaused(next);
  };
  return (
    <div className="hero-quote">
      <p className="typed" aria-label="首页文案">
        <span aria-hidden="true">
          {paused || reduced ? sentence : text}
          <span className={`cursor ${paused || reduced ? "is-paused" : ""}`}>
            |
          </span>
        </span>
        <span className="quote-accessible">{sentence}</span>
      </p>
      {reduced ? (
        <span className="quote-control">已停止动态换句</span>
      ) : (
        <button
          type="button"
          className="quote-control"
          aria-pressed={paused}
          onClick={toggle}
        >
          {paused ? "继续换句" : "暂停换句"}
        </button>
      )}
    </div>
  );
}
