# Fonts

Self-hosted, so no request ever leaves the app to fetch a typeface. It is the
variable WOFF2 build published by [Fontsource](https://fontsource.org), cut to the
Latin and Latin Extended subsets; `index.css` declares it with `unicode-range`, so
the extended file only loads when a message needs it.

| Family | Use | Files | Licence |
| --- | --- | --- | --- |
| IBM Plex Sans (wght 100–700) | Interface | `ibm-plex-sans-latin*-wght-normal.woff2` | SIL OFL 1.1, [OFL-IBMPlexSans.txt](OFL-IBMPlexSans.txt) |

Source: `@fontsource-variable/ibm-plex-sans@5.3.0`, unmodified. (Source Serif 4 was
bundled until October 2026, for the subject and plain-text bodies; both are Plex now.)
