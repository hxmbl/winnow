/**
 * The custom accent's colour field (1.4.0), under the accent cards in Settings.
 *
 * The browser's own colour picker (`<input type="color">`: a wheel on Android, the OS
 * panel on the desktop) and a hex field beside it for a colour someone already knows.
 * The Custom card opens the picker straight away (`openRef`); the field appears once
 * Custom is the accent. Until then it stays in the page, visually hidden, out of the tab
 * order and of the accessibility tree, so the card can open the picker in the same click
 * (a `display: none` input cannot always open one).
 *
 * What is stored is the colour as picked. What paints is that colour made AA-safe for
 * the mode (`customAccentFor` in `theme.ts`), and when the two visibly differ the field
 * says so, in one quiet line.
 */

import { useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import { normalizeHexColor } from "../../core/model/appearance";

/** The Custom card's swatch before it is the accent: a soft wheel of the curated hues. */
export const CUSTOM_SWATCH_IDLE =
  "conic-gradient(from 200deg, #B9A5FF, #D4A3CE, #EB9CB8, #F0964F, #79C289, #5ED6C5, #86B7EA, #B9A5FF)";

/** The note when the mode on screen had to move the colour. */
export const CUSTOM_ADJUSTED_NOTE = "Adjusted slightly for contrast";

export function CustomAccentField({
  active,
  value,
  adjusted,
  onChange,
  openRef,
}: {
  /** Custom is the accent: show the field. */
  active: boolean;
  /** The colour as picked, `#RRGGBB`. */
  value: string;
  /** The mode on screen paints a visibly different colour. */
  adjusted: boolean;
  onChange: (hex: string) => void;
  /** Filled with a function that opens the native picker, for the Custom card. */
  openRef: MutableRefObject<(() => void) | null>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const [draft, setDraft] = useState(value);
  // Follow the stored colour when it changes elsewhere (the picker, another window).
  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    openRef.current = () => {
      const input = picker.current;
      if (!input) return;
      try {
        if (typeof input.showPicker === "function") input.showPicker();
        else input.click();
      } catch {
        // No picker here (no user activation, a headless browser): the field is still there.
      }
    };
    return () => {
      openRef.current = null;
    };
  }, [openRef]);

  const valid = normalizeHexColor(draft);
  const commit = () => {
    if (valid && valid !== value) onChange(valid);
    else if (!valid) setDraft(value);
  };

  return (
    <div
      data-custom-accent=""
      aria-hidden={active ? undefined : true}
      className={active ? "flex flex-wrap items-center gap-x-3 gap-y-1 pt-1" : "sr-only"}
    >
      <label className="flex items-center gap-2 text-meta font-medium text-ink-muted">
        <input
          ref={picker}
          type="color"
          data-custom-accent-picker=""
          value={value.toLowerCase()}
          tabIndex={active ? 0 : -1}
          onChange={(event) => {
            const hex = normalizeHexColor(event.target.value);
            if (hex) onChange(hex);
          }}
          className="wn-color-well h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-full border border-hairline bg-transparent p-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-10 max-sm:w-10"
        />
        <span>Colour</span>
      </label>
      <input
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        maxLength={7}
        tabIndex={active ? 0 : -1}
        aria-label="Custom colour, as a hex code"
        aria-invalid={!valid}
        aria-describedby={adjusted ? noteId : undefined}
        data-custom-accent-hex=""
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className={`w-24 rounded-ctl border bg-surface px-2.5 py-1 text-meta tabular-nums text-ink outline-hidden focus-visible:border-accent max-sm:min-h-10 ${
          valid ? "border-hairline" : "border-danger"
        }`}
      />
      {adjusted && (
        <p id={noteId} data-custom-accent-note="" className="text-meta text-ink-subtle">
          {CUSTOM_ADJUSTED_NOTE}
        </p>
      )}
    </div>
  );
}
