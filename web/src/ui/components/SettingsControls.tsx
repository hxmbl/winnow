/**
 * The building blocks of Settings: a section, a labelled row, a radio-card group and a
 * switch. Moved out of `SettingsPanel.tsx` unchanged.
 */

import { useRef } from "react";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-hairline-soft px-5 py-4 last:border-b-0">
      <h3 className="text-meta font-semibold text-ink-subtle">
        {title}
      </h3>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** A labelled row: a name, an explanation, and a control. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    /*
      Wraps rather than squeezes. The label wants at least 14rem; a control that will not
      fit beside that (a segmented control on a phone) drops to its own line under the
      label, and the label keeps the full width. A small control (a switch, a button)
      still sits on the right.
    */
    <div data-settings-row="" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-[1_1_14rem]">
        <p className="text-ui font-medium text-ink-body">{label}</p>
        {hint && <p className="text-meta text-ink-subtle">{hint}</p>}
      </div>
      <div data-settings-control="" className="max-w-full shrink-0">{children}</div>
    </div>
  );
}

/**
 * A labelled group of radios, laid out as a row of equal cells.
 *
 * A real radio group to assistive technology and to the keyboard: one tab stop (the
 * checked option), arrow keys move the choice and the focus together, Home and End jump
 * to the ends — the behaviour a screen-reader user expects from `role="radiogroup"`.
 * The label is a visible heading the group points at, not an `aria-label` only a screen
 * reader would hear.
 */
export function RadioCards<T extends string>({
  id,
  label,
  hint,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  options: readonly { value: T; label: string; swatch?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (index: number) => {
    const next = (index + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p id={`${id}-label`} className="text-ui font-medium text-ink-body">
          {label}
        </p>
        {hint && (
          <p id={`${id}-hint`} className="text-meta text-ink-subtle">
            {hint}
          </p>
        )}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        data-picker={id}
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
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
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") move(index + 1);
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(index - 1);
                else if (event.key === "Home") move(0);
                else if (event.key === "End") move(options.length - 1);
                else return;
                event.preventDefault();
              }}
              className={`flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-ctl border px-2 py-1.5 text-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-11 ${
                checked
                  ? "border-accent bg-surface-selected font-semibold text-ink"
                  : "border-hairline font-medium text-ink-muted hover:bg-surface-hover hover:text-ink-body"
              }`}
            >
              {option.swatch && (
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: option.swatch }}
                />
              )}
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A switch. A real checkbox, visually restyled — not a `div` with a click handler. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
        checked ? "bg-accent" : "bg-surface-active"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-surface transition-transform ${
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
