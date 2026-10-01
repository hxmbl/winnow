/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Mirrors `theme.color` in src/theme.ts. Keep the two in sync.
        canvas: 'var(--wn-canvas)',
        surface: 'var(--wn-surface)',
        'surface-sunken': 'var(--wn-surfaceSunken)',
        'surface-hover': 'var(--wn-surfaceHover)',
        'surface-active': 'var(--wn-surfaceActive)',
        panel: 'var(--wn-panel)',
        chrome: 'var(--wn-chrome)',

        ink: 'var(--wn-ink)',
        'ink-body': 'var(--wn-inkBody)',
        'ink-muted': 'var(--wn-inkMuted)',
        'ink-subtle': 'var(--wn-inkSubtle)',
        'ink-icon': 'var(--wn-inkIcon)',
        'ink-placeholder': 'var(--wn-inkPlaceholder)',

        hairline: 'var(--wn-hairline)',
        'hairline-soft': 'var(--wn-hairlineSoft)',
        divider: 'var(--wn-divider)',
        'control-border': 'var(--wn-controlBorder)',
        'focus-ring': 'var(--wn-focusRing)',

        avatar: 'var(--wn-avatar)',
      },
      boxShadow: {
        pane: 'var(--wn-elev-pane)',
        lift: 'var(--wn-elev-lift)',
      },
      borderRadius: {
        // The radius every pane, cluster and chip is built on.
        pane: '14px',
      },
      animation: {
        appear: 'appear 0.2s ease-out',
      },
      keyframes: {
        appear: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};