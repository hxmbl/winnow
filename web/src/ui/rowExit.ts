/**
 * A row leaving the list (archive, delete, a move): it fades and slides a little to the
 * left as the rows below take its place, instead of vanishing in one frame.
 *
 * The store removes the row at once, as before: nothing waits on the animation, so a
 * fast run of `e` presses is never slowed down or queued. What animates is a *ghost*, a
 * copy of the row's pixels laid over the spot it left, stripped of every id, data
 * attribute and accessible name so nothing (a test, a screen reader, a click) can find
 * it, and removed when its 180ms are up.
 *
 * Reduced motion: no ghost.
 */

/** How long the ghost takes to go, in ms. */
export const ROW_EXIT_MS = 180;

/** The ghost's keyframes: a fade with a short slide, eased in (it is leaving). */
export function rowExitKeyframes(): Keyframe[] {
  return [
    { opacity: 1, transform: "translateX(0)" },
    { opacity: 0, transform: "translateX(-12px)" },
  ];
}

export const ROW_EXIT_EASING = "cubic-bezier(0.4, 0, 1, 1)";

/** Whether a row on screen gets a ghost: never under reduced motion, never off screen. */
export function rowExitAllowed(reducedMotion: boolean, rect: { top: number; bottom: number; height: number } | null, viewport: number): boolean {
  if (reducedMotion || !rect || rect.height <= 0) return false;
  return rect.bottom > 0 && rect.top < viewport;
}

/**
 * A ghost of `element`: a copy of its pixels, fixed over `rect` (where it sits on screen
 * now) and clipped to `clip` (the list's visible band), stripped of every id, data
 * attribute, accessible name and title so no query, screen reader or click can find it.
 * Not yet in the document; the caller appends it and removes it when its motion is done.
 *
 * Shared with the filter switch (`useFilterSwitchMotion`), whose leaving rows are ghosts
 * of the same kind: `[data-message-id]` and `[data-row-id]` keep meaning "a row in the
 * list" while anything fades out over it.
 */
export function ghostOf(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number; bottom: number },
  clip: { top: number; bottom: number },
): HTMLElement {
  const ghost = element.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === "id" || attribute.name.startsWith("data-") || attribute.name.startsWith("aria-") || attribute.name === "title") {
        node.removeAttribute(attribute.name);
      }
    }
  }
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.dataset.rowGhost = "";
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "10",
    // Clipped to the list, so a row half under the floating header leaves no ghost
    // over the header.
    clipPath: `inset(${Math.max(0, clip.top - rect.top)}px 0 ${Math.max(0, rect.bottom - clip.bottom)}px 0)`,
  });
  return ghost;
}

/**
 * Lay a ghost over each of `ids`' rows that is on screen, then let `remove` take the
 * rows out. Safe to call with ids that are not mounted (they are skipped).
 */
export function exitRows(ids: readonly number[], remove: () => void): void {
  const doc = globalThis.document;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const scroller = doc?.querySelector<HTMLElement>("[data-row-count]");
  const host = scroller?.parentElement;
  if (!doc || !scroller || !host || reduced || typeof scroller.animate !== "function") {
    remove();
    return;
  }
  const box = scroller.getBoundingClientRect();
  const ghosts: HTMLElement[] = [];
  for (const id of ids.slice(0, 40)) {
    const row = scroller.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
    const rect = row?.getBoundingClientRect() ?? null;
    if (!row || !rowExitAllowed(false, rect, box.bottom) || !rect) continue;
    const ghost = ghostOf(row, rect, box);
    ghosts.push(ghost);
  }
  remove();
  for (const ghost of ghosts) {
    host.appendChild(ghost);
    const animation = ghost.animate(rowExitKeyframes(), { duration: ROW_EXIT_MS, easing: ROW_EXIT_EASING, fill: "forwards" });
    const done = () => ghost.remove();
    animation.addEventListener("finish", done);
    animation.addEventListener("cancel", done);
    // Belt and braces: a tab in the background can hold an animation's finish.
    globalThis.setTimeout(done, ROW_EXIT_MS + 120);
  }
}
