# Fonts

Self-hosted, so no request ever leaves the app to fetch a typeface. Both are the
variable WOFF2 builds published by [Fontsource](https://fontsource.org), cut to the
Latin and Latin Extended subsets; `index.css` declares them with `unicode-range`, so
the extended file only loads when a message needs it.

| Family | Use | Files | Licence |
| --- | --- | --- | --- |
| IBM Plex Sans (wght 100–700) | Interface | `ibm-plex-sans-latin*-wght-normal.woff2` | SIL OFL 1.1, [OFL-IBMPlexSans.txt](OFL-IBMPlexSans.txt) |
| Source Serif 4 (opsz 8–60, wght 200–900) | Subjects and plain-text bodies | `source-serif-4-latin*-opsz-normal.woff2` | SIL OFL 1.1, [OFL-SourceSerif4.txt](OFL-SourceSerif4.txt) |

Sources: `@fontsource-variable/ibm-plex-sans@5.3.0` and
`@fontsource-variable/source-serif-4@5.3.1`, unmodified.
