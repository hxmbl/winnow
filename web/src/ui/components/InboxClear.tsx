/**
 * The two good-news empty states: a clear Inbox (or smart filter), and the quieter one
 * for an empty folder or filter. `ui/inboxClear.ts` decides which, and what they say.
 *
 * The clear state is an ambient-light illustration around the app mark — drawn by
 * `AppMark` as one plane (`single`: the leading one, recentred, so the pair's second
 * plane does not fly against the trail), with a dashed flight trail running up to its
 * tail — and a line that follows the time of day. When the last item has just been cleared, `celebrating` plays
 * one gentle motion: the trail draws in, the mark settles at its end and the light
 * blooms. Its end state is the resting state, so dropping the class changes nothing on
 * screen, and under `prefers-reduced-motion` nothing moves at all.
 *
 * The light is the accent mixed into transparency (`inboxClear.css`), so it follows the
 * four accents and the three modes without a palette entry of its own; OLED keeps it
 * dimmer, so a black screen stays black around it.
 */

import { FolderOpen, SearchX } from "lucide-react";
import { AppMark } from "../AppMark";
import { clearDetail, clearHeadline, quietLine, type EmptyKind } from "../inboxClear";
import "./InboxClear.css";

type Action = { label: string; run: () => void };

export function InboxClear({
  kind,
  now,
  celebrating,
  action,
  line,
}: {
  kind: EmptyKind;
  /** The store's clock, so the line changes with the time of day. */
  now: number;
  celebrating: boolean;
  /** The quiet state's remedy, or the clear state's quiet "show the held-back mail". */
  action?: Action | null;
  /** Replaces the quiet state's line (Drafts says "No drafts."). */
  line?: string;
}) {
  if (kind.kind === "quiet") {
    const Icon = kind.scope === "folder" ? FolderOpen : SearchX;
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-surface px-6 text-center"
        data-empty-kind="quiet"
        data-empty-scope={kind.scope}
      >
        <Icon size={22} strokeWidth={1.5} className="text-ink-subtle" aria-hidden="true" />
        <p className="max-w-[26rem] text-ui text-ink-muted">{quietLine(kind, line)}</p>
        {action && (
          <button
            type="button"
            onClick={action.run}
            className="rounded-ctl border border-control-border px-3.5 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-11"
          >
            {action.label}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="inbox-clear flex min-h-0 flex-1 flex-col items-center justify-center bg-surface px-6 pb-10 text-center"
      data-empty-kind="clear"
      data-empty-scope={kind.scope}
      data-celebrating={celebrating || undefined}
    >
      <div className="inbox-clear__art" aria-hidden="true">
        <span className="inbox-clear__glow inbox-clear__glow--wide" />
        <span className="inbox-clear__glow inbox-clear__glow--core" />
        <svg className="inbox-clear__trail" viewBox="0 0 240 150" fill="none">
          <path
            className="inbox-clear__path"
            d="M 18 128 C 62 126 82 96 112 92 C 132 89 142 77 149 67"
            pathLength={100}
          />
          <circle className="inbox-clear__dot" cx="18" cy="128" r="2.5" />
        </svg>
        <span className="inbox-clear__mark">
          <AppMark size={56} single />
        </span>
      </div>
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-1.5">
        <p className="text-read font-semibold text-ink" data-clear-headline="">
          {clearHeadline(kind, new Date(now))}
        </p>
        <p className="max-w-[24rem] text-ui text-ink-muted">{clearDetail(kind)}</p>
      </div>
      {action && (
        <button
          type="button"
          onClick={action.run}
          className="mt-3 rounded-ctl px-2 py-1 text-meta font-semibold text-ink-subtle underline underline-offset-2 hover:text-ink-body max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          data-clear-action=""
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
