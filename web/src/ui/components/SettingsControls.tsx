/**
 * The building blocks of Settings: a section, a labelled row, a radio-card group, a
 * switch, and the hover/focus wiring and (?) popover that explain each setting.
 */

import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { SETTINGS, type SettingId } from "../settingsCatalog";
import { SettingsExplain } from "../settingsExplainContext";
import { placePopover, type PopoverPlacement } from "../settingsView";

export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-hairline-soft py-4 first:pt-0 last:border-b-0">
      {title && <h3 className="mb-3 text-meta font-semibold text-ink-subtle">{title}</h3>}
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

/**
 * The area a setting owns: pointing at it (hover, or keyboard focus entering it) makes it
 * the one the explanation column describes. Leaving does nothing, on purpose: the column
 * keeps the last one, so moving the pointer across to read it does not clear it.
 */
export function SettingBlock({
  setting,
  className = "",
  children,
}: {
  setting: SettingId;
  className?: string;
  children: React.ReactNode;
}) {
  const { point, mode, pointed } = useContext(SettingsExplain);
  // The row the explanation column is describing, so the two read as a pair.
  const explained = mode === "panel" && pointed === setting;
  return (
    <div
      data-setting={setting}
      data-explained={explained ? "" : undefined}
      onPointerEnter={() => point(setting)}
      onFocus={() => point(setting)}
      className={`-mx-3 rounded-pane px-3 py-2.5 transition-colors ${explained ? "bg-surface-hover" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/** A setting's name, with its (?) button below 1200px. */
export function SettingLabel({ setting, id }: { setting: SettingId; id?: string }) {
  const { mode } = useContext(SettingsExplain);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span id={id} className="text-ui font-medium text-ink-body">
        {SETTINGS[setting].label}
      </span>
      {mode === "popover" && <InfoButton setting={setting} />}
    </span>
  );
}

/**
 * The (?) beside a setting's name below 1200px, and the popover it opens.
 *
 * Hover (a mouse) and focus show it; a click or tap pins it; Escape, a second press or a
 * tap anywhere else closes it. Escape is caught on the window in the capture phase so it
 * closes the popover rather than Settings. The popover is portalled to the body (so a
 * transformed ancestor cannot move a fixed box) and placed by `placePopover`, which keeps
 * it inside the viewport.
 */
export function InfoButton({ setting }: { setting: SettingId }) {
  const { info, dispatchInfo } = useContext(SettingsExplain);
  const open = info.open === setting;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PopoverPlacement | null>(null);
  const tipId = `winnow-about-${setting}`;
  const definition = SETTINGS[setting];

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const height = tipRef.current?.offsetHeight ?? 120;
      setPlace(
        placePopover(
          { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          height,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    measure();
    // Once more after the first placement: the height depends on the width just set.
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      setPlace(null);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      dispatchInfo({ type: "escape" });
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (buttonRef.current?.contains(target) || tipRef.current?.contains(target))) return;
      dispatchInfo({ type: "outside" });
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, dispatchInfo]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-setting-info={setting}
        aria-label={`About ${definition.label}`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") dispatchInfo({ type: "hover", setting });
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") dispatchInfo({ type: "unhover", setting });
        }}
        onFocus={() => dispatchInfo({ type: "focus", setting })}
        onBlur={() => dispatchInfo({ type: "blur", setting })}
        onClick={() => dispatchInfo({ type: "press", setting })}
        className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-subtle transition-colors hover:text-ink-body focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring aria-expanded:text-accent after:absolute after:-inset-2.5 after:content-['']"
      >
        <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            data-setting-popover={setting}
            className="fixed z-70 rounded-pane border border-hairline bg-chrome p-3 shadow-lift"
            style={{
              top: place?.top ?? 0,
              left: place?.left ?? 0,
              width: place?.width ?? Math.min(320, window.innerWidth - 16),
              visibility: place ? "visible" : "hidden",
            }}
          >
            <p className="text-meta font-semibold text-ink">{definition.label}</p>
            <p className="mt-1 text-meta leading-relaxed text-ink-muted">{definition.explanation}</p>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A labelled row: a name, an optional status line, and a control.
 *
 * With `setting`, the name comes from the catalog, the row reports hover and focus to the
 * explanation column, and below 1200px it carries a (?) button. Without, it is a plain
 * row (a hidden sender's address beside its Unhide button).
 */
export function Row({
  setting,
  label,
  hint,
  hintId,
  children,
}: {
  setting?: SettingId;
  label?: string;
  /** A short, live status line (the client in use, whether contacts are connected). */
  hint?: string;
  /** An id for the hint, so the control can name it with `aria-describedby`. */
  hintId?: string;
  children: React.ReactNode;
}) {
  const row = (
    /*
      Wraps rather than squeezes. The label wants at least 14rem; a control that will not
      fit beside that (a segmented control on a phone) drops to its own line under the
      label, and the label keeps the full width. A small control (a switch, a button)
      still sits on the right.
    */
    <div data-settings-row="" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-[1_1_14rem]">
        {setting ? (
          <SettingLabel setting={setting} />
        ) : (
          <p className="text-ui font-medium text-ink-body">{label}</p>
        )}
        {hint && (
          <p id={hintId} className="text-meta text-ink-subtle">
            {hint}
          </p>
        )}
      </div>
      <div data-settings-control="" className="max-w-full shrink-0">{children}</div>
    </div>
  );
  return setting ? <SettingBlock setting={setting}>{row}</SettingBlock> : row;
}

/**
 * A labelled group of radios, laid out as a row of equal cells.
 *
 * A real radio group to assistive technology and to the keyboard: one tab stop (the
 * checked option), arrow keys move the choice and the focus together, Home and End jump
 * to the ends — the behaviour a screen-reader user expects from `role="radiogroup"`.
 * The label is the setting's visible name the group points at, not an `aria-label` only
 * a screen reader would hear.
 */
export function RadioCards<T extends string>({
  id,
  setting,
  options,
  value,
  onChange,
  onOptionClick,
  after,
}: {
  id: string;
  setting: SettingId;
  /** `swatch` is any CSS background: a colour, or a gradient (the custom accent's wheel). */
  options: readonly { value: T; label: string; swatch?: string }[];
  value: T;
  onChange: (value: T) => void;
  /** A pointer click (or Enter/Space) on an option, after `onChange`; arrow keys do not call it. */
  onOptionClick?: (value: T) => void;
  /** Anything that belongs to the group under its cards (the custom colour's field). */
  after?: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (index: number) => {
    const next = (index + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <SettingBlock setting={setting} className="flex flex-col gap-2">
      <SettingLabel setting={setting} id={`${id}-label`} />
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        data-picker={id}
        // Wraps (1.4.0: nine accents): as many cells of at least 6.25rem as fit, so a
        // phone shows three rows of three and the desktop's wider column two rows.
        className="grid gap-1.5"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(6.25rem, 1fr))" }}
      >
        {options.map((option, index) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              data-value={option.value}
              onClick={() => {
                onChange(option.value);
                onOptionClick?.(option.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") move(index + 1);
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(index - 1);
                else if (event.key === "Home") move(0);
                else if (event.key === "End") move(options.length - 1);
                else return;
                event.preventDefault();
              }}
              className={`flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-ctl border px-2 py-1.5 text-meta transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-11 ${
                checked
                  ? "border-accent bg-surface-selected font-semibold text-ink"
                  : "border-hairline font-medium text-ink-muted hover:bg-surface-hover hover:text-ink-body"
              }`}
            >
              {option.swatch && (
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: option.swatch }}
                />
              )}
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
      {after}
    </SettingBlock>
  );
}

/** A switch. A real checkbox, visually restyled — not a `div` with a click handler. */
export function Toggle({
  checked,
  onChange,
  label,
  describedBy,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  /** The id of a line that says more, read after the name (`aria-describedby`). */
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
        checked ? "bg-accent" : "bg-surface-active"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-surface transition-transform ${
          checked ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
