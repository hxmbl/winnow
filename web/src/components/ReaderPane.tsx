import { useMemo } from "react";
import {
  ArrowLeft,
  BellRing,
  Flag,
  MailOpen,
  Newspaper,
  Shield,
  Star,
  Tag,
  TriangleAlert,
} from "lucide-react";
import type { RelayEmail } from "../inbox/types";
import { FILTER_LABELS, classifyEmail, type EmailSignals, type UserProfile } from "../inbox/smart";
import { formatFullTime } from "../inbox/time";
import { hexA } from "../inbox/palette";
import { badgeColor } from "../theme";

function displayName(email: RelayEmail): string {
  if (email.name) return email.name;
  return email.sender.includes("@") ? email.sender.split("@")[0] : email.sender;
}

const BADGE_ICONS = {
  starred: Star,
  important: Flag,
  urgent: BellRing,
  security: Shield,
  newsletters: Newspaper,
  promotional: Tag,
  unsafe: TriangleAlert,
} as const;

type BadgeKey = keyof typeof BADGE_ICONS;

/** Which signals this email has. Icons, labels and colours all live elsewhere. */
function badgesFor(email: RelayEmail, sig: EmailSignals): BadgeKey[] {
  return [
    email.starred && "starred",
    sig.importanceScore >= 70 && "important",
    sig.urgentText && "urgent",
    sig.security && "security",
    sig.newsletter && "newsletters",
    sig.promotional && "promotional",
    sig.spamLikelihood >= 0.4 && "unsafe",
  ].filter((key): key is BadgeKey => Boolean(key));
}

/**
 * A badge with its name attached. Bare icons forced the reader to decode a
 * pictogram against a legend it couldn't see; the tint is the same accent the
 * filter pill uses, so the two ends of the app agree on what "Urgent" is.
 */
function Badge({ badgeKey }: { badgeKey: BadgeKey }) {
  const Icon = BADGE_ICONS[badgeKey];
  const color = badgeColor(badgeKey);
  return (
    <li
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold leading-none"
      style={{ background: hexA(color, 0.09), color }}
    >
      <Icon size={12} strokeWidth={2.25} aria-hidden="true" />
      {FILTER_LABELS[badgeKey]}
    </li>
  );
}

type Props = {
  email: RelayEmail | null;
  onBack: () => void;
  profile: UserProfile;
  className?: string;
};

export default function ReaderPane({
  email,
  onBack,
  profile,
  className = "",
}: Props) {
  const sig = useMemo(
    () => (email ? classifyEmail(email, profile) : null),
    [email, profile],
  );

  const badges = email && sig ? badgesFor(email, sig) : [];

  return (
    <aside
      aria-label="Message"
      className={`relative flex min-h-0 flex-col bg-panel ${className}`}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline bg-chrome px-4 lg:hidden">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-label="Back to list"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
          {email ? displayName(email) : "Message"}
        </span>
      </div>

      {!email ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline text-ink-subtle">
            <MailOpen size={18} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <p className="text-[15px] font-semibold text-ink">Nothing selected</p>
          <p className="max-w-[26ch] text-[13px] leading-relaxed text-ink-muted">
            Pick a message from the list and it will open here.
          </p>
        </div>
      ) : (
        <div className="reader-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* references/reader-detail.svg: 24px gutters, flush, no card. The
              measure is capped so the body never runs long on a wide pane. */}
          <div className="mx-auto w-full max-w-[680px] px-6 py-7">
            <header>
              <div className="flex items-start gap-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-avatar text-[15px] font-semibold text-ink-subtle"
                  aria-hidden="true"
                >
                  {displayName(email).trim().charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-4">
                    <h2 className="min-w-0 truncate text-[15px] font-semibold leading-tight text-ink">
                      {displayName(email)}
                    </h2>
                    <time
                      className="shrink-0 text-[11.5px] tabular-nums text-ink-subtle"
                      dateTime={new Date(email.receivedAt).toISOString()}
                    >
                      {formatFullTime(email.receivedAt)}
                    </time>
                  </div>
                  <p className="mt-0.5 truncate text-[12.5px] leading-snug text-ink-muted">
                    {email.email ?? email.sender}
                  </p>
                </div>
              </div>

              {badges.length > 0 && (
                <ul className="mt-4 flex flex-wrap gap-1.5">
                  {badges.map((key) => (
                    <Badge key={key} badgeKey={key} />
                  ))}
                </ul>
              )}
            </header>

            <div className="mt-6 border-t border-hairline-soft" />

            <h1 className="mt-6 max-w-[42ch] text-[26px] font-bold leading-[1.2] tracking-[-0.02em] text-ink">
              {email.subject}
            </h1>

            <div className="mt-5 max-w-[68ch] whitespace-pre-wrap text-[14.5px] leading-[1.7] text-ink-body">
              {email.body}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}