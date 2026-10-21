/**
 * The first-run tour (1.5): five short steps over the demo inbox — the mailboxes,
 * reading, smart filters, the menu, then "go and explore" with Connect Gmail.
 *
 * Everything here is pure, so the decisions are unit-tested: which steps a layout gets
 * and what they say, whether the tour starts on its own, where the card goes beside the
 * thing it points at, and what a key does. `components/Tour.tsx` draws it.
 *
 * - **Once, on a first launch.** Not for anyone upgrading: a device that already holds
 *   any `winnow.*` key at boot (preferences, an account, the update check's state, a
 *   cached mailbox) has run Winnow before. Finishing or skipping sets `tourDone`, so it
 *   does not come back; Settings › About › "Show the tour again" replays it.
 * - **Never in an automated browser** (`navigator.webdriver`, the smoke tests), as the
 *   update check is not, unless the page opts in (`window.__WINNOW_TOUR__ = true`, set by
 *   the tour's own smoke part), so every other smoke run sees the app as it always was.
 */

export type TourStepId = "mailboxes" | "reading" | "filters" | "menu" | "explore";

export type TourStep = {
  id: TourStepId;
  title: string;
  body: string;
  /**
   * What the spotlight is cut around, as selectors tried in order; the first that is on
   * screen wins. None (or none visible) and the card sits in the middle of the window.
   */
  targets: readonly string[];
  /** Whether the menu (the sidebar, or the phone dock's expanded panel) is open for this step. */
  menu: boolean;
  /** The side of the target the card tries first. */
  prefer: CardSide;
};

export type CardSide = "below" | "above" | "right" | "left";

export const TOUR_STEP_COUNT = 5;

/** The steps, in order, for the phone layout or the desktop one. */
export function tourSteps(phone: boolean): TourStep[] {
  return [
    phone
      ? {
          id: "mailboxes",
          title: "Your mailboxes",
          body: "Every mailbox lives in this menu, with Inbox nearest your thumb. The arrows on the dock open and close it, and Inbox and Sent sit on the dock itself.",
          targets: ["[data-sidebar][data-open]", "[data-phone-pill]"],
          menu: true,
          prefer: "above",
        }
      : {
          id: "mailboxes",
          title: "Your mailboxes",
          body: "Inbox, and every other mailbox: Snoozed, Archive, Sent, Drafts and Trash. Open this menu with the button at the top left, or press [.",
          targets: ["[data-sidebar][data-open] [data-mail-nav]", "[data-list-chrome] [data-sidebar-toggle]"],
          menu: true,
          prefer: "right",
        },
    {
      id: "reading",
      title: "Reading",
      body: phone
        ? "Tap a message to read it. Swipe one left to move it to the Trash, or right to mark it read."
        : "Choose a message and it opens in the reader beside the list. j and k step through your mail from the keyboard.",
      targets: ["[data-row-count] [data-row-id]"],
      menu: false,
      prefer: "below",
    },
    {
      id: "filters",
      title: "Smart filters",
      body: phone
        ? "Winnow sorts your mail into these for you: important, deliveries, new contacts, things that need doing. Tap one to see only that, and tap it again to see everything."
        : "Winnow sorts your mail into these for you: important, deliveries, new contacts, things that need doing. Click one to see only that, and click it again to see everything.",
      targets: phone ? ["[data-phone-chips] [data-rail]", "[data-phone-chips]"] : ["[data-list-chrome] [data-rail]"],
      menu: false,
      prefer: phone ? "above" : "below",
    },
    phone
      ? {
          id: "menu",
          title: "The menu",
          body: "Your account is at the top of the menu: tap it to connect Gmail or sign out. The gear opens Settings.",
          targets: ["[data-sidebar][data-open] [data-nav-account]"],
          menu: true,
          prefer: "above",
        }
      : {
          id: "menu",
          title: "The menu",
          body: "Your account is at the foot of the menu: choose it to connect Gmail or sign out. The gear opens Settings, or press the comma key.",
          targets: ["[data-sidebar][data-open] [data-nav-account]"],
          menu: true,
          prefer: "right",
        },
    {
      id: "explore",
      title: "Have fun — go and explore",
      // The last card's body depends on whether there is a Gmail to connect: see `exploreCopy`.
      body: "",
      targets: [],
      menu: false,
      prefer: "below",
    },
  ];
}

/** The last card: its body and its two buttons, in the demo or with an account open. */
export function exploreCopy(connectLabel: string | null): { body: string; primary: string; secondary: string | null } {
  if (connectLabel === null) {
    return {
      body: "That's the whole tour. Everything else is yours to find.",
      primary: "Done",
      secondary: null,
    };
  }
  return {
    body: "This is demo mail, so nothing you try here leaves your device. When you'd like Winnow on your own inbox, connect Gmail.",
    primary: connectLabel,
    secondary: "Explore the demo",
  };
}

/** "Step 2 of 5: Reading", for the screen-reader announcement and the card's label. */
export function stepAnnouncement(index: number, step: TourStep): string {
  return `Step ${index + 1} of ${TOUR_STEP_COUNT}: ${step.title}`;
}

// ── Starting on its own ─────────────────────────────────────────────────────

/**
 * Whether this device has run Winnow before: any `winnow.*` key, read at boot before
 * anything is written. Every version that has ever launched leaves one (preferences,
 * the accounts registry, the token store, the update check's state, a cached mailbox).
 */
export function isExistingInstall(keys: Iterable<string>): boolean {
  for (const key of keys) if (key.startsWith("winnow.")) return true;
  return false;
}

export type TourStartContext = {
  /** The preference: finished or skipped before. */
  tourDone: boolean;
  /** See `isExistingInstall`. */
  existingInstall: boolean;
  /** `navigator.webdriver`: a browser driven by automation. */
  automated: boolean;
  /** The page asked for the tour anyway (`window.__WINNOW_TOUR__`, the tour's smoke part). */
  optIn: boolean;
};

/** Whether the tour opens by itself on this launch. */
export function shouldStartTour(context: TourStartContext): boolean {
  if (context.automated && !context.optIn) return false;
  if (context.tourDone) return false;
  return !context.existingInstall;
}

// ── Keys ────────────────────────────────────────────────────────────────────

export type TourKeyAction = "next" | "back" | "skip" | "none";

/**
 * What a key does while the tour is open. Enter only means Next when focus is not on a
 * button: on a button, the button's own activation is the answer (Back, Skip, Connect).
 */
export function tourKeyAction(key: string, onButton: boolean): TourKeyAction {
  if (key === "Escape") return "skip";
  if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown") return "next";
  if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") return "back";
  if (key === "Enter" && !onButton) return "next";
  return "none";
}

/** The step after a move, kept inside the tour. `null` past the end: the tour is finished. */
export function stepAfter(index: number, action: "next" | "back"): number | null {
  if (action === "back") return Math.max(0, index - 1);
  return index + 1 >= TOUR_STEP_COUNT ? null : index + 1;
}

// ── Placing the card ────────────────────────────────────────────────────────

export type Box = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };

/** How far the card keeps from the window's edges, and from the spotlight's. */
export const TOUR_EDGE = 12;
export const TOUR_GAP = 14;
/** The spotlight's padding around its target. */
export const SPOTLIGHT_PAD = 6;

/**
 * The target's box if it is worth pointing at: on screen, with some size. A target that
 * is missing, collapsed or scrolled out of the window gets the centred card instead.
 */
export function visibleTarget(box: Box | null, viewport: Size): Box | null {
  if (!box || box.width < 4 || box.height < 4) return null;
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (right <= 0 || bottom <= 0 || box.left >= viewport.width || box.top >= viewport.height) return null;
  // Clipped to the window, so a list taller than the screen still gets a hole on screen.
  const top = Math.max(0, box.top);
  const left = Math.max(0, box.left);
  return {
    top,
    left,
    width: Math.min(viewport.width, right) - left,
    height: Math.min(viewport.height, bottom) - top,
  };
}

/** The spotlight's hole: the target grown by its padding, kept inside the window. */
export function spotlightBox(target: Box, viewport: Size, pad = SPOTLIGHT_PAD): Box {
  const top = Math.max(2, target.top - pad);
  const left = Math.max(2, target.left - pad);
  const bottom = Math.min(viewport.height - 2, target.top + target.height + pad);
  const right = Math.min(viewport.width - 2, target.left + target.width + pad);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export type CardPlacement = { top: number; left: number; side: CardSide | "centre" };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where the card goes: beside the spotlight on the preferred side if it fits there, then
 * the other sides in turn (below, above, right, left), and centred in the window when
 * there is no target or no side has room. Always kept `TOUR_EDGE` inside the window.
 */
export function placeCard(hole: Box | null, card: Size, viewport: Size, prefer: CardSide = "below"): CardPlacement {
  const centred: CardPlacement = {
    top: Math.round(clamp((viewport.height - card.height) / 2, TOUR_EDGE, viewport.height - card.height - TOUR_EDGE)),
    left: Math.round(clamp((viewport.width - card.width) / 2, TOUR_EDGE, viewport.width - card.width - TOUR_EDGE)),
    side: "centre",
  };
  if (!hole) return centred;
  const maxLeft = viewport.width - card.width - TOUR_EDGE;
  const maxTop = viewport.height - card.height - TOUR_EDGE;
  const alignX = clamp(hole.left, TOUR_EDGE, maxLeft);
  const alignY = clamp(hole.top, TOUR_EDGE, maxTop);
  const fits: Record<CardSide, CardPlacement | null> = {
    below:
      hole.top + hole.height + TOUR_GAP + card.height <= viewport.height - TOUR_EDGE
        ? { top: hole.top + hole.height + TOUR_GAP, left: alignX, side: "below" }
        : null,
    above:
      hole.top - TOUR_GAP - card.height >= TOUR_EDGE
        ? { top: hole.top - TOUR_GAP - card.height, left: alignX, side: "above" }
        : null,
    right:
      hole.left + hole.width + TOUR_GAP + card.width <= viewport.width - TOUR_EDGE
        ? { top: alignY, left: hole.left + hole.width + TOUR_GAP, side: "right" }
        : null,
    left:
      hole.left - TOUR_GAP - card.width >= TOUR_EDGE
        ? { top: alignY, left: hole.left - TOUR_GAP - card.width, side: "left" }
        : null,
  };
  const order: CardSide[] = [prefer, ...(["below", "above", "right", "left"] as const).filter((side) => side !== prefer)];
  for (const side of order) {
    const placed = fits[side];
    if (placed) return { top: Math.round(placed.top), left: Math.round(placed.left), side };
  }
  return centred;
}
