/*
 * The theme, before anything else.
 *
 * A classic (blocking) script in <head>, loaded from 'self' because the desktop CSP
 * forbids inline script. It runs before the first paint and before the module bundle
 * has even been fetched, and does one thing: put the stored mode and accent on <html>
 * as `data-theme` / `data-accent`, so the fallbacks in `index.css` paint the right
 * backdrop. Without it a dark-mode user sees a light flash on every launch.
 *
 * It must agree with `resolveScheme` in `src/ui/theme.ts`: `system` follows the OS to
 * light or dark (never OLED). `theme.test.ts` runs this file against that function.
 * Anything unreadable falls through to `system`, exactly as the app itself would.
 */
(function () {
  var MODES = ["system", "light", "dark", "oled"];
  var ACCENTS = ["space", "plum", "rose", "ember", "green", "aurora", "blue", "graphite"];
  var appearance = "system";
  var accent = "space";
  try {
    var raw = window.localStorage && window.localStorage.getItem("winnow.preferences.v1");
    var stored = raw ? JSON.parse(raw) : null;
    if (stored && MODES.indexOf(stored.appearance) !== -1) appearance = stored.appearance;
    if (stored && ACCENTS.indexOf(stored.accent) !== -1) accent = stored.accent;
    // The custom colour (1.4.0) is only named here; its tones need the bundle's arithmetic.
    if (stored && stored.accent === "custom") accent = "custom";
  } catch (error) {
    // Private mode, a full quota, a corrupt blob: the defaults stand.
  }
  var mode = appearance;
  if (mode === "system") {
    var dark = false;
    try {
      dark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (error) {
      dark = false;
    }
    mode = dark ? "dark" : "light";
  }
  var root = document.documentElement;
  root.setAttribute("data-theme", mode);
  root.setAttribute("data-accent", accent);
  root.style.colorScheme = mode === "light" ? "light" : "dark";
})();
