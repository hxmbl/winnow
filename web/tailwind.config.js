/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
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
        panel: "var(--wn-panel)",
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

        avatar: "var(--wn-avatar)",

        danger: "var(--wn-danger)",
        success: "var(--wn-success)",
        notice: "var(--wn-notice)",
        "danger-wash": "var(--wn-dangerWash)",
      },

      boxShadow: {
        pane: "var(--wn-elev-pane)",
        lift: "var(--wn-elev-lift)",
      },

      borderRadius: {
        // The radius every pane, cluster and chip is built on. One value, so the
        // app has a single corner language rather than three near-identical ones.
        pane: "14px",
      },

      /**
       * A type scale.
       *
       * The previous version had none — every component wrote an arbitrary value
       * like `text-[13.5px]`, which is why the reader and the list ended up with
       * two similar-but-not-equal sizes. These are the sizes that scale is
       * actually built on, named for their job.
       *
       * The list is scanned and the reader is read, so the list sits a size
       * smaller throughout: a row has to fit sender, subject and preview on
       * three lines without the preview becoming the thing you read.
       */
      fontSize: {
        // 11px — uppercase section labels and counts.
        micro: ["11px", { lineHeight: "1.4" }],
        // 11.5px — the timestamp column in a list row.
        tiny: ["11.5px", { lineHeight: "1.35" }],
        // 12.5px — the preview line under a subject.
        preview: ["12.5px", { lineHeight: "1.4" }],
        // 13px — toolbar labels and pills.
        ui: ["13px", { lineHeight: "1.4" }],
        // 13.5px — the sender and subject lines in a list row.
        row: ["13.5px", { lineHeight: "1.35" }],
        // 14.5px — the reader's body copy.
        body: ["14.5px", { lineHeight: "1.65" }],
        // 26px — the reader's subject.
        subject: ["26px", { lineHeight: "1.25" }],
      },

      fontFamily: {
        // Named rather than inlined at each use, so the fallback chain is one
        // decision. `ui-sans-serif` first so the OS's own UI font wins on each
        // platform, which is what makes a native-feeling app on all three.
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
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
        // The reader appearing. 200ms: long enough to read as motion, short
        // enough that holding `j` does not queue up a backlog of cross-fades.
        appear: "appear 0.2s ease-out",
        // The sheet rising. Slightly slower, because a sheet is a bigger object
        // and a bigger object needs a little more time to arrive.
        sheet: "sheet 0.16s cubic-bezier(0.2, 0, 0, 1)",
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
      },
    },
  },
  plugins: [],
};
