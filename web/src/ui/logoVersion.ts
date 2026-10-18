/**
 * The logo's version toggle, in the phone's top bar and the desktop's floating bar.
 *
 * Tapping the Winnow mark swaps the search field for the words "Winnow <version>"; tapping it
 * again brings search back. The version is the build's own (`PlatformInfo.version`: the
 * web build's comes from package.json through `vite.config.ts`, the desktop and Android
 * builds' from Tauri), never a literal here. Search is never unmounted while the version
 * shows, so its query and state survive the round trip, and anything that means "search"
 * (the `/` key, focusing the field) brings the field back first.
 *
 * Pure, so the rules are tested without a DOM (`logoVersion.test.ts`); the components
 * hold the state and the crossfade (`.wn-logo-swap` in `index.css`).
 */

/** What the bar's middle shows: the search field, or the app's name and version. */
export type LogoView = "search" | "version";

/** What can change it: the mark itself, or anything asking for search. */
export type LogoEvent = "logo" | "focusSearch";

/** The mark's accessible name. It does not change with the state: `aria-pressed` does. */
export const VERSION_TOGGLE_LABEL = "Show Winnow version";

/** The app's name, and its version when the build has said what it is. */
export function versionText(version: string | null | undefined): string {
  const v = version?.trim();
  return v ? `Winnow ${v}` : "Winnow";
}

/** The next view: the mark toggles; a request for search always lands on search. */
export function logoViewAfter(view: LogoView, event: LogoEvent): LogoView {
  if (event === "focusSearch") return "search";
  return view === "search" ? "version" : "search";
}

/** Whether the mark reads as pressed (the version showing), for `aria-pressed`. */
export function logoPressed(view: LogoView): boolean {
  return view === "version";
}

/** The tick a phone gives when the mark is tapped, in ms. None on the desktop. */
export function logoHaptic(phone: boolean): number | null {
  return phone ? 8 : null;
}
