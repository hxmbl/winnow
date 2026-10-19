/**
 * The app mark, inline and theme-aware.
 *
 * Inlining it removes the need for a second asset or a media query: the two colours
 * are the app's own tokens — `currentColor` for the body and `var(--wn-chrome)` for
 * the slash cut through it — so they follow `applyTheme`, which already handles
 * `systemDark`.
 *
 * The name said `Light`, which is the tell: there was no dark version, and no branch
 * anywhere that chose one.
 *
 * The path data is the original 512×512 artwork, unchanged — only the two fills are
 * variables now.
 */

/**
 * The leading plane on its own, framed square around it: the one pointing up and to the
 * right, the way the inbox-clear trail flies. Its box in the artwork is x 74–279,
 * y 146–306, so a 230-unit square centred on it (176, 226) leaves the same margin all
 * round and the plane sits in the middle rather than where it sat in the pair.
 */
const SINGLE_VIEWBOX = "61 111 230 230";

export function AppMark({ size = 36, single = false }: { size?: number; single?: boolean }) {
  return (
    <svg
      viewBox={single ? SINGLE_VIEWBOX : "0 0 512 512"}
      data-app-mark={single ? "single" : "pair"}
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0 text-ink"
    >
      {/*
        Two planes, each with a slash cut through it. The group transform centres
        the pair in the viewBox. `single` draws only the leading one (inbox clear).
      */}
      {!single && (
        <g transform="translate(-35.849192,-11.030521)">
          <path
            d="m 234.85817,373.19928 79.97127,-157.64452 57.79819,42.0129 11.19359,-8.03777 7.76226,21.63708 46.42011,41.82405 z"
            fill="currentColor"
          />
          <path
            d="m 267.08615,348.39093 104.87384,-90.31765 11.86123,-8.54339 6.80232,21.933 z"
            fill="var(--wn-chrome)"
          />
        </g>
      )}
      {/* The leading plane: up and to the right, the second plane's mirror. */}
      <g data-plane="lead">
        <path
          d="m 278.52065,145.69479 -81.8097,160.40216 -56.99102,-41.82406 -16.35541,24.54466 -3.40761,-38.79242 -45.960501,-42.28366 z"
          fill="currentColor"
        />
        <path
          d="m 224.24298,186.86915 -102.90725,61.08776 2.02879,40.86064 16.35541,-24.54466 z"
          fill="var(--wn-chrome)"
        />
      </g>
    </svg>
  );
}
