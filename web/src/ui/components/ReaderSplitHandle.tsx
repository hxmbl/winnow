/**
 * The divider between the list and the reader, on the wide layout only.
 *
 * Drag it, or focus it and use the arrow keys, to give the reader more or less of the
 * width; double-click puts it back. The split is the reader's *fraction* of `main` (see
 * `readerSplit.ts`), written as a CSS variable on the container, so a live drag never
 * re-renders the app: the pane's width is `clamp()`ed in `index.css` from that variable,
 * which is also where the pixel minimums are resolved against the width of the moment.
 *
 * It sits between the two panes as a zero-width flex child, and the hit area is a strip
 * centred on the boundary. It is outside `MessageList`'s scroller, so a press on it never
 * reaches the list's avatar drag-select or its row clicks; text selection is vetoed for
 * the length of a drag on top of that.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  DEFAULT_READER_FRACTION,
  READER_SPLIT_KEY,
  READER_SPLIT_VAR,
  fractionAtPointer,
  listPercent,
  loadReaderFraction,
  percentBounds,
  saveReaderFraction,
  splitBounds,
  splitCssValue,
  clampReaderFraction,
  stepReaderFraction,
} from "../readerSplit";

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function ReaderSplitHandle({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  // The split as chosen, unclamped: a split made in a wide window comes back with it.
  const [fraction, setFraction] = useState(() => loadReaderFraction(storage()));
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const live = useRef(fraction);
  const drag = useRef<{ pointerId: number; offset: number; frame: number | null; x: number } | null>(null);

  const publish = useCallback(
    (value: number) => {
      live.current = value;
      containerRef.current?.style.setProperty(READER_SPLIT_VAR, splitCssValue(value));
    },
    [containerRef],
  );

  // The variable follows the committed split.
  useEffect(() => {
    publish(fraction);
  }, [fraction, publish]);

  // Another window (or tab) changing the split: follow it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === READER_SPLIT_KEY) setFraction(loadReaderFraction(storage()));
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => globalThis.removeEventListener?.("storage", onStorage);
  }, []);

  // The width the minimums are resolved against, for the ARIA value and the key steps.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setWidth(container.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  const commit = useCallback((value: number) => {
    setFraction(value);
    live.current = value;
    saveReaderFraction(storage(), value);
  }, []);

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, keep: boolean) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      drag.current = null;
      setDragging(false);
      document.documentElement.removeAttribute("data-resizing");
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const container = containerRef.current;
      if (keep && container) {
        const rect = container.getBoundingClientRect();
        commit(fractionAtPointer(current.x - current.offset, rect.left, rect.width));
      } else {
        publish(fraction);
      }
    },
    [commit, containerRef, fraction, publish],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (!splitBounds(rect.width).resizable) return;
    event.preventDefault();
    event.stopPropagation();
    // Where on the strip it was grabbed, so the divider does not jump to the pointer.
    const boundary = rect.left + rect.width * (1 - clampReaderFraction(live.current, rect.width));
    drag.current = { pointerId: event.pointerId, offset: event.clientX - boundary, frame: null, x: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.getSelection()?.removeAllRanges();
    document.documentElement.setAttribute("data-resizing", "");
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    if (current.frame !== null) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = null;
      const container = containerRef.current;
      if (!container || drag.current !== current) return;
      const rect = container.getBoundingClientRect();
      publish(fractionAtPointer(current.x - current.offset, rect.left, rect.width));
    });
  };

  // A drag that never lets go (the window losing focus mid-drag) must not leave the page
  // unselectable.
  useEffect(
    () => () => {
      document.documentElement.removeAttribute("data-resizing");
    },
    [],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = stepReaderFraction(live.current, event.key, event.shiftKey, width);
    if (next === null) return;
    // The app's own shortcuts listen on `window`; these keys are the handle's.
    event.preventDefault();
    event.stopPropagation();
    commit(next);
  };

  const effective = clampReaderFraction(fraction, width);
  const bounds = percentBounds(width);
  const resizable = splitBounds(width).resizable;
  // Rounded into the rounded bounds, so Home reads exactly as aria-valuemin.
  const now = Math.min(bounds.max, Math.max(bounds.min, listPercent(effective)));

  return (
    <div className="relative z-10 hidden w-0 shrink-0 lg:block">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the reader"
        aria-valuenow={now}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuetext={`List ${now}%, reader ${100 - now}%`}
        aria-disabled={resizable ? undefined : true}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        data-reader-split=""
        data-dragging={dragging ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onLostPointerCapture={(event) => endDrag(event, true)}
        onDoubleClick={(event) => {
          event.preventDefault();
          commit(DEFAULT_READER_FRACTION);
        }}
        onKeyDown={onKeyDown}
        className="wn-split group absolute inset-y-0 -left-1 flex w-2 cursor-col-resize touch-none select-none justify-center focus-visible:outline-hidden"
      >
        <span
          aria-hidden="true"
          className="h-full w-px bg-hairline-soft transition-colors duration-150 group-hover:bg-divider group-focus-visible:w-0.5 group-focus-visible:bg-focus-ring group-data-dragging:w-0.5 group-data-dragging:bg-accent"
        />
      </div>
    </div>
  );
}
