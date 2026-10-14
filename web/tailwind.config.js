/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    /**
     * The type scale. Four steps and nothing else.
     *
     * Overriding rather than extending, so Tailwind's own `text-sm`/`text-lg` do not
     * exist and an arbitrary `text-[13px]` is caught by `theme.test.ts`. Hierarchy comes
     * from weight and colour inside a step, not from a fifth size.
     *
     *   meta  12px — timestamps, counts, captions, section labels
     *   ui    14px — rows, controls, everything you scan
     *   read  16px — message bodies, dialog titles, phone inputs (iOS zooms below 16)
     *   title 24px — the reader's subject
     */
    fontSize: {
      meta: ["12px", { lineHeight: "1.4" }],
      ui: ["14px", { lineHeight: "1.45" }],
      read: ["16px", { lineHeight: "1.6" }],
      title: ["24px", { lineHeight: "1.25" }],
    },

    /**
     * Two radii. `ctl` for anything you press or type into, `pane` for sheets, cards
     * and the dock. `full` is kept for things that are genuinely round (a dot, a switch)
     * and is not a control radius.
     */
    borderRadius: {
      none: "0",
      ctl: "6px",
      pane: "12px",
      full: "9999px",
    },

    extend: {
      // Every colour resolves to a custom property written by `applyTheme`, so a
      // scheme change is one `style.setProperty` sweep rather than a re-render
      // of every styled element. Keep these names in sync with the palettes in
      // `src/ui/theme.ts` — a name that exists in one and not the other
      // silently produces an unstyled element rather than a build error.
      colors: {
        canvas: "var(--wn-canvas)",
        surface: "var(--wn-surface)",
        "surface-sunken": "var(--wn-surfaceSunken)",
        "surface-hover": "var(--wn-surfaceHover)",
        "surface-active": "var(--wn-surfaceActive)",
        chrome: "var(--wn-chrome)",

        ink: "var(--wn-ink)",
        "ink-body": "var(--wn-inkBody)",
        "ink-muted": "var(--wn-inkMuted)",
        "ink-subtle": "var(--wn-inkSubtle)",
        "ink-icon": "var(--wn-inkIcon)",
        "ink-placeholder": "var(--wn-inkPlaceholder)",

        hairline: "var(--wn-hairline)",
        "hairline-soft": "var(--wn-hairlineSoft)",
        divider: "var(--wn-divider)",
        "control-border": "var(--wn-controlBorder)",
        "focus-ring": "var(--wn-focusRing)",
        // Transparent except on OLED, where it is the only thing separating black planes.
        edge: "var(--wn-edge)",

        // The accent. One colour, four jobs: unread, selection, focus and the primary
        // action. Anything else that wants colour is asking for the wrong thing.
        accent: "var(--wn-accent)",
        "on-accent": "var(--wn-onAccent)",
        "surface-selected": "var(--wn-surfaceSelected)",

        danger: "var(--wn-danger)",
        success: "var(--wn-success)",
        notice: "var(--wn-notice)",
        "danger-wash": "var(--wn-dangerWash)",

        /**
         * Depth without borders. `veil` is the translucent fill for anything that
         * floats over content and is paired with a `backdrop-filter`; `sheen` is
         * selection expressed as a low-alpha wash of the palette's own ink, so it
         * darkens on a light scheme and lightens on a dark one; `scrim` is what the
         * drawer dims.
         *
         * All three are CSS variables, so — as the note in `theme.ts` puts it — none
         * of them may be combined with Tailwind's `/opacity` modifier, which emits
         * `rgb(var(--wn-veil) / 0.5)`, is not a colour, and silently renders nothing.
         * `theme.test.ts` asserts that over every token in this map.
         */
        veil: "var(--wn-veil)",
        sheen: "var(--wn-sheen)",
        scrim: "var(--wn-scrim)",
      },

      // Flat for now: both resolve to `none` (see `theme.ts`), and the hooks stay so
      // elevation can come back as one token change rather than a sweep of every pane.
      boxShadow: {
        pane: "var(--wn-elev-pane)",
        lift: "var(--wn-elev-lift)",
      },

      fontFamily: {
        // IBM Plex Sans for the interface, self-hosted (see `src/assets/fonts`). The
        // system stack stays behind it so a missing file degrades to a native app
        // rather than to Times.
        sans: [
          "IBM Plex Sans",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // Source Serif 4 for the things that are *read*: the subject and a plain-text
        // body. It has an optical-size axis, so the same file draws the 24px subject
        // with display contrast and the 16px body with text contrast. Quoted inside the
        // string: an unquoted family name containing "4" is invalid CSS, and the browser
        // drops the whole declaration.
        serif: ['"Source Serif 4"', "ui-serif", "Georgia", "Cambria", "Times New Roman", "serif"],
        // For message bodies and addresses, where digits should line up.
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },

      /**
       * Two animations, both short.
       *
       * Anything longer starts to read as the app being slow rather than the
       * content being new, and in a keyboard-driven client a transition that
       * outlasts your next keypress is actively hostile.
       */
      animation: {
        // The reader appearing. 160ms: long enough to read as motion, short
        // enough that holding `j` does not queue up a backlog of cross-fades.
        appear: "appear 0.16s ease-out",
        // The sheet rising. Slightly slower, because a sheet is a bigger object
        // and a bigger object needs a little more time to arrive.
        sheet: "sheet 0.16s cubic-bezier(0.2, 0, 0, 1)",
        /**
         * The navigation drawer coming out of the left edge.
         *
         * Translation only, and no scale: it is a *place* arriving rather than a
         * card appearing, and a scale would make a full-height surface visibly
         * shrink as it opened, which reads as a bug rather than as motion. 180ms
         * with a decelerating curve, so it leaves quickly and settles softly —
         * the opposite of the ease-out used for content, because nothing here is
         * being *replaced*.
         */
        drawer: "drawer 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
      },

      keyframes: {
        appear: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        sheet: {
          "0%": { opacity: "0", transform: "translateY(6px) scale(0.99)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        drawer: {
          "0%": { opacity: "0", transform: "translateX(-100%)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
    },
  },
  plugins: [],
};
