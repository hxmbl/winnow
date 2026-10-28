/**
 * A dropdown for a setting with several values (1.3.3): a pill showing the current
 * value, which opens a short list under it. Used in Settings where a row of buttons got
 * long (undo send, sort order, remote images, mode, the sync interval). Simple on/off
 * stays a switch.
 *
 * The shapes are the app's own: the trigger is a pill with a hairline (not glass; Settings
 * is an opaque page), and the list is the context menu's surface (`Menu.tsx`): the pane
 * radius, a hairline, the chrome colour, the same pop-in.
 *
 * Keyboard (the WAI-ARIA "select-only combobox" pattern, kept small):
 *   - on the trigger, ↓ ↑ Enter or Space open the list on the current value;
 *   - in the list, ↓ ↑ Home End move (skipping disabled values), a letter jumps to the
 *     next value starting with it, Enter or Space choose, Escape or Tab close;
 *   - closing by a key puts focus back on the trigger. Escape is caught on the window in
 *     the capture phase, so it closes the list and not Settings.
 * Placement reuses `placeMenu`: under the trigger, flipping above it near the bottom of
 * the screen (the phone's floating dock sits there), never off screen.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { anchorFromElement, placeMenu } from "../menuPlacement";
import { nextEnabled, typeAhead } from "../selectMenu";

export type SelectOption<T extends string | number> = {
  value: T;
  label: string;
  /** Read instead of `label` where the label alone is terse ("Off" → "Undo send off"). */
  ariaLabel?: string;
  disabled?: boolean;
  /** A colour dot before the label. */
  swatch?: string;
};

export function SelectMenu<T extends string | number>({
  id,
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  /** Names the control for tests: `data-select="<id>"`. */
  id: string;
  /** The accessible name of the control (the setting's name). */
  label: string;
  options: readonly SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[selectedIndex];
  const enabled = options.map((option) => !option.disabled);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openAt = (index: number) => {
    if (disabled) return;
    setActive(enabled[index] ? index : nextEnabled(enabled, index, 1));
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const trigger = triggerRef.current;
      const list = listRef.current;
      if (!trigger || !list) return;
      list.style.minWidth = `${trigger.offsetWidth}px`;
      const rect = list.getBoundingClientRect();
      setPlace(
        placeMenu(anchorFromElement(trigger), { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }),
      );
    };
    measure();
  }, [open]);

  // Focus moves into the list once it is placed: before that it is `visibility: hidden`,
  // and a hidden element cannot take focus (the keys would stay on the trigger).
  const placed = place !== null;
  useEffect(() => {
    if (open && placed) listRef.current?.focus({ preventScroll: true });
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      close(true);
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (listRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      close(false);
    };
    const onViewport = (event: Event) => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      close(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onViewport);
    document.addEventListener("scroll", onViewport, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onViewport);
      document.removeEventListener("scroll", onViewport, true);
    };
  }, [open, close]);

  const onListKey = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        setActive((index) => nextEnabled(enabled, index, 1));
        break;
      case "ArrowUp":
        setActive((index) => nextEnabled(enabled, index, -1));
        break;
      case "Home":
        setActive(nextEnabled(enabled, -1, 1));
        break;
      case "End":
        setActive(nextEnabled(enabled, options.length, -1));
        break;
      case "Enter":
      case " ":
        choose(active);
        break;
      case "Tab":
        close(false);
        return;
      default: {
        const jump = typeAhead(
          options.map((option) => option.label),
          enabled,
          active,
          event.key,
        );
        if (jump !== null) setActive(jump);
        // Every other key stops here, so the app's shortcuts stay quiet.
        event.stopPropagation();
        if (event.key.length === 1) event.preventDefault();
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-select={id}
        data-value={String(value)}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openAt(selectedIndex))}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            openAt(selectedIndex);
          }
        }}
        className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-ctl border border-control-border bg-surface pl-3 pr-2 text-meta font-medium text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 aria-expanded:bg-surface-hover max-sm:h-10 max-sm:pl-3.5"
      >
        {current?.swatch && <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: current.swatch }} />}
        <span className="truncate">{current?.label}</span>
        <ChevronDown size={14} strokeWidth={2.2} aria-hidden="true" className={`shrink-0 text-ink-subtle transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={`${listId}-${active}`}
            data-select-list={id}
            onKeyDown={onListKey}
            style={{ position: "fixed", top: place?.top ?? 0, left: place?.left ?? 0, visibility: place ? "visible" : "hidden" }}
            className={`${place ? "animate-menu" : ""} z-70 flex max-w-[min(320px,calc(100vw-16px))] flex-col gap-px rounded-pane border border-hairline bg-chrome p-1 text-ink-body shadow-lift outline-hidden`}
          >
            {options.map((option, index) => {
              const selected = index === selectedIndex;
              return (
                <div
                  key={String(option.value)}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  aria-label={option.ariaLabel}
                  data-option={String(option.value)}
                  data-active={index === active ? "" : undefined}
                  onPointerMove={() => {
                    if (!option.disabled && index !== active) setActive(index);
                  }}
                  onClick={() => choose(index)}
                  className={`flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-ctl px-2.5 py-1.5 text-ui transition-colors data-active:bg-sheen [@media(hover:none)]:min-h-11 ${
                    option.disabled ? "opacity-40" : ""
                  } ${selected ? "font-semibold text-ink" : ""}`}
                >
                  <span className="flex w-4 shrink-0 justify-center text-accent">
                    {selected && <Check size={15} strokeWidth={2.4} aria-hidden="true" />}
                  </span>
                  {option.swatch && <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: option.swatch }} />}
                  <span className="min-w-0 flex-1 truncate pr-2">{option.label}</span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
