import { useRef, useState } from 'react';
import { createDocument, type GridDocument } from './types';

export function useHistory() {
  const [document, setDocument] = useState(createDocument);
  const current = useRef(document);
  const past = useRef<GridDocument[]>([]);
  const future = useRef<GridDocument[]>([]);
  const grouping = useRef(false);
  const captured = useRef(false);
  const [, refresh] = useState(0);

  function change(update: (value: GridDocument) => GridDocument, record = true) {
    const next = update(current.current);
    if (next === current.current || JSON.stringify(next) === JSON.stringify(current.current)) return;
    if (record) {
      if (!grouping.current || !captured.current) {
        past.current = [...past.current.slice(-49), current.current];
        captured.current = true;
      }
      future.current = [];
    }
    current.current = next;
    setDocument(next);
  }
  function beginGesture() { grouping.current = true; captured.current = false; }
  function endGesture() { grouping.current = false; captured.current = false; }
  function undo() {
    endGesture();
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(current.current);
    current.current = previous;
    setDocument(previous);
    refresh(n => n + 1);
  }
  function redo() {
    endGesture();
    const next = future.current.pop();
    if (!next) return;
    past.current.push(current.current);
    current.current = next;
    setDocument(next);
    refresh(n => n + 1);
  }
  return { document, current, change, beginGesture, endGesture, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
