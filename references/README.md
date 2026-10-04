# references

Design artifacts dragged in from Figma. Renamed to describe what they are; the
original frame names are kept here so they can be traced back.

| File | Figma frame | Size | What it is |
| --- | --- | --- | --- |
| `reader-detail.svg` | `Frame 17` | 546×900 | A crop of `Desktop - 1` showing just the reader pane — not a separate mobile design. Source of the `#FAFFFF` panel, the 24px gutters, and the 24px name/subject type scale. |
| `inbox-desktop.svg` | `Desktop - 1` | 1440×900 | Full desktop layout: top bar, list, empty reader. |
| `inbox-desktop.png` | `Desktop - 1` | 1440×900 | Raster preview of the above. |
| `filter-pill-gradients.svg` | `Group 4` | 2432×83 | The smart-filter pill ramp — 11 categorical hues plus greys. Source of `RAMP` in `web/src/inbox/palette.ts`. |
| `relay-logo.svg` | — | 512×512 | App mark, as drawn. The app does not serve this file: `web/src/ui/AppMark.tsx` inlines the same paths and takes its two colours from the theme tokens, so the mark follows `systemDark` with no second asset. `web/public/relayLight.svg` and `relayDark.svg` are the served copies, the second for the browser tab — which is not ours to theme. |

Text in these exports is outlined to paths, so the fills are black and there is
no selectable copy. The gradients, however, are intact and machine-readable.
