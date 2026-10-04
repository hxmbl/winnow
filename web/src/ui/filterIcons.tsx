/**
 * The smart-filter icon vocabulary.
 *
 * One map, one meaning per bucket, read by both the list row and the reader. It
 * exists because the previous design communicated a bucket with a *coloured dot* —
 * six of them, in a row, in the categorical ramp — and that is a colour key the
 * user has to learn, cannot read at a glance, and loses entirely in dark mode, in
 * a screenshot, and to anyone with a colour vision deficiency.
 *
 * So the shape carries the meaning and the colour is gone. `important` is a filled
 * star because importance is what a star means everywhere; `urgent` is a
 * lightning bolt; `security` is a shield. None of those are Winnow's invention,
 * which is the point — an icon the user already recognises needs no legend, and a
 * legend is a thing to be read once and remembered forever.
 *
 * ## Why one file and not two call sites
 *
 * The reader and the row both classify, and they used to classify *differently*:
 * the row drew a dot from `rowIndicators` (which hides category buckets) and the
 * reader drew a chip from `badgeFilters` (which does not). Two renderings of one
 * judgement, in the same window, on the same message. The icon lives here, keyed
 * by the bucket id, so a bucket cannot mean one shape in a row and another in the
 * reader — the drift that made "why does this say Urgent there and not here" a
 * reasonable question.
 *
 * ## The explanation
 *
 * `FILTER_EXPLANATIONS` is what the icon's `title` and accessible name say. A bare
 * icon is a claim the user has to decode; the hover text is the same claim in
 * words, and it is what makes the shape *explanatory* rather than merely
 * decorative. It is short on purpose — a tooltip is read at a glance, mid-triage.
 *
 * `FILTER_LABELS` in `core/model/signals` remains the canonical *name* of a
 * bucket. This file does not restate it; it says what the name means here.
 */

import {
  Bookmark,
  BookOpen,
  CalendarDays,
  Circle,
  Clock3,
  KeyRound,
  Megaphone,
  MessageCircle,
  Newspaper,
  Package,
  Paperclip,
  Plane,
  Receipt,
  Reply,
  ShieldAlert,
  Siren,
  Star,
  UserPlus,
  UserRound,
  Users,
  Zap,
} from "lucide-react";
import { FILTER_LABELS, type BuiltinSmartFilter } from "../core/model/signals";

/**
 * One icon per bucket.
 *
 * Pairs that would otherwise collide are separated on *shape* rather than colour,
 * which is why `shipping` is a box and `travel` is a plane and not two shades of
 * the same green.
 *
 * **`important` is deliberately not a star.** The row already has a star on it, and
 * that star is a *control* — pressing it is how you star a message. An "important"
 * glyph that looked like it would mean the same thing put a non-interactive icon
 * directly above an interactive one, on every row, and the only way to tell them
 * apart was to know which one was which. A bookmark is the nearest thing that means
 * "set aside" and does not collide with anything else in the app.
 */
export const FILTER_ICONS: Record<
  BuiltinSmartFilter,
  React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
> = {
  important: Bookmark,
  urgent: Zap,
  needs_action: Reply,
  security: ShieldAlert,
  unsafe: Siren,
  starred: Star,
  /** An empty circle is the universal "not yet filled in" — i.e. not read. */
  unread: Circle,
  new_senders: UserPlus,
  top_contacts: Users,
  quiet_contacts: UserRound,
  attachments: Paperclip,
  codes: KeyRound,
  shipping: Package,
  travel: Plane,
  events: CalendarDays,
  receipts: Receipt,
  social: MessageCircle,
  newsletters: Newspaper,
  promotional: Megaphone,
  low_priority: Clock3,
  long_reads: BookOpen,
};

/**
 * Why Winnow thinks a message is in a bucket, in a few words.
 *
 * Deliberately phrased as a claim about the *message* rather than as a restatement
 * of the label. "Important" on its own is the classifier's verdict and tells the
 * reader nothing; "Important — from someone you reply to" is the reason, and it is
 * the reason that makes a user willing to act on the verdict.
 *
 * Kept short. These are `title` attributes read in passing while scanning a list,
 * not paragraphs.
 */
export const FILTER_EXPLANATIONS: Record<BuiltinSmartFilter, string> = {
  important: "Important — from someone you read or reply to",
  urgent: "Urgent — wants an answer soon",
  needs_action: "Needs a reply from you",
  security: "Security — an alert about your account",
  unsafe: "Likely junk or phishing",
  starred: "Starred by you",
  unread: "You have not read this yet",
  new_senders: "New — someone you have not corresponded with",
  top_contacts: "From someone you read most",
  quiet_contacts: "Rarely from you",
  attachments: "Has a file attached",
  codes: "A one-time or verification code",
  shipping: "A delivery or an order",
  travel: "A booking or an itinerary",
  events: "An invitation or a reminder",
  receipts: "A receipt or an invoice",
  social: "A social network notification",
  newsletters: "A mailing list",
  promotional: "An advertisement",
  low_priority: "Read later — nothing is waiting on you",
  long_reads: "Long, and not urgent",
};

/**
 * The icon for a bucket, and the words that explain it.
 *
 * Returned together because every call site needs both, and splitting them into two
 * lookups is how a row ends up explaining one bucket and drawing another.
 */
export function filterIcon(
  id: BuiltinSmartFilter,
): {
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  /** The label *and* its reason, which is what a tooltip should say. */
  title: string;
} {
  return {
    Icon: FILTER_ICONS[id],
    label: FILTER_LABELS[id],
    title: FILTER_EXPLANATIONS[id],
  };
}
