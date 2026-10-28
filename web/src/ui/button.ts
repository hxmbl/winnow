/**
 * The one button recipe.
 *
 * Every text button in the app is one of three variants at one of three heights, so two
 * buttons on one screen can never drift apart in height, padding or weight the way the
 * ~14 pasted copies did (`px-4 py-1.5` here, `px-3.5 py-1.5` there, `py-2.5` on the sign-in
 * screen, a medium-weight primary in the reader).
 *
 *   primary    filled accent, semibold. The one primary action in a view; the accent
 *              means exactly that, so a view has at most one.
 *   secondary  hairline outline, medium. Cancel, Discard, Not now, settings actions.
 *   ghost      no fill until hover, medium. Quiet actions inside a busy pane.
 *
 *   sm     32px, meta text: settings rows, inline actions, the demo strip.
 *   md     36px, ui text: dialogs, sheets, the composer, the masthead.
 *   touch  44px, ui text: phone-first screens (sign-in), and any button a thumb owns.
 *
 * `tone: "danger"` recolours a secondary or ghost button's label (Remove, Sign out); a
 * destructive *primary* is `bg-danger`, which the confirm dialog asks for with `danger`.
 *
 * Layout extras (`w-full`, `max-sm:min-h-11`, `ml-auto`) go in `extra`; anything that
 * restates height, padding, size, weight or colour belongs here instead. `theme.test.ts`
 * fails on a pasted recipe outside this file.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "touch";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl transition-[background-color,color,opacity] disabled:opacity-50 aria-disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-meta",
  md: "h-9 px-4 text-ui",
  touch: "h-11 px-4 text-ui",
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent font-semibold text-on-accent hover:opacity-90",
  // A destructive confirm: the danger fill with the surface as its ink, as the confirm
  // dialog always drew it.
  danger: "bg-danger font-semibold text-(--wn-surface) hover:opacity-90",
  secondary: "border border-control-border font-medium hover:bg-surface-hover",
  ghost: "font-medium hover:bg-sheen",
};

const INK = {
  default: "text-ink-body hover:text-ink",
  danger: "text-danger",
} as const;

export function buttonClass(
  variant: ButtonVariant,
  size: ButtonSize = "md",
  extra = "",
  { tone = "default" }: { tone?: keyof typeof INK } = {},
): string {
  const ink = variant === "primary" || variant === "danger" ? "" : INK[tone];
  return [BASE, BUTTON_SIZES[size], VARIANTS[variant], ink, extra].filter(Boolean).join(" ");
}
