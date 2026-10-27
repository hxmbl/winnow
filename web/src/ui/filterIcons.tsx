/**
 * The smart-filter icon vocabulary: one map, one meaning per bucket, read by both the
 * list row and the reader.
 *
 * The shape carries the meaning, so a bucket reads the same in dark mode, in a
 * screenshot, and to anyone with a colour vision deficiency. The colour (the chip's hue,
 * from `filterColors`) only backs it up.
 * `important` is the importance marker people already know from Gmail; `urgent` is a
 * warning triangle; `security` is a shield. An icon the user already
 * recognises needs no legend, and a legend is a thing to be read once and remembered
 * forever.
 *
 * Kept in one file, keyed by bucket id, so a bucket cannot mean one shape in a row and
 * another in the reader — the drift that made "why does this say Urgent there and not
 * here" a reasonable question.
 *
 * `FILTER_EXPLANATIONS` is what the icon's `title` and accessible name say: the same
 * claim in words, which makes the shape *explanatory* rather than merely decorative. It
 * is short on purpose — a tooltip is read at a glance, mid-triage. `FILTER_LABELS` in
 * `core/model/signals` remains the canonical *name* of a bucket; this file says what the
 * name means here.
 */

import {
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
  TriangleAlert,
  UserPlus,
  UserRound,
  Users,
} from "lucide-react";
import { boxIcon } from "./filterIconBox";
import { ImportantMarker } from "./ImportantMarker";
import { FILTER_LABELS, type BuiltinSmartFilter } from "../core/model/signals";

/**
 * One icon per bucket.
 *
 * Colliding pairs are separated on *shape* rather than colour, which is why `shipping`
 * is a box and `travel` is a plane and not two shades of the same green.
 *
 * **`important` is deliberately not a star.** The row already has a star on it, and
 * that star is a *control* — pressing it is how you star a message. An "important"
 * glyph that looked like it would mean the same thing put a non-interactive icon
 * directly above an interactive one on every row. A bookmark is the nearest thing that
 * means "set aside" and does not collide with anything else.
 */
export const FILTER_ICONS: Record<
  BuiltinSmartFilter,
  React.ComponentType<{ size?: number; strokeWidth?: number; className?: string; viewBox?: string }>
> = {
  /** The importance marker people know from Gmail (our own drawing, `ImportantMarker`). */
  important: ImportantMarker,
  /** A warning triangle: act now. A different shape from Important's marker. */
  urgent: TriangleAlert,
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
 * What `filterIcon` hands out: each glyph above in one square box at one visual size and
 * stroke weight (`boxIcon`). Built once, not per render.
 */
const BOXED_ICONS = Object.fromEntries(
  (Object.keys(FILTER_ICONS) as BuiltinSmartFilter[]).map((id) => [id, boxIcon(id, FILTER_ICONS[id])]),
) as Record<BuiltinSmartFilter, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>>;

/**
 * Why Winnow thinks a message is in a bucket, in a few words.
 *
 * Phrased as a claim about the *message*, not a restatement of the label: "Important"
 * is the classifier's verdict and tells the reader nothing; "Important — from someone
 * you reply to" is the reason, and the reason is what makes a user willing to act on
 * the verdict.
 *
 * Kept short. These are `title` attributes read in passing while scanning a list, not
 * paragraphs.
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
    Icon: BOXED_ICONS[id],
    label: FILTER_LABELS[id],
    title: FILTER_EXPLANATIONS[id],
  };
}
