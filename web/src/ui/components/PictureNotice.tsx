import { useId } from "react";
import { CircleUserRound } from "lucide-react";
import { PICTURE_NOTICE_COPY, type PictureNoticeKind } from "../pictureNotice";
import { QUIET_BUTTON } from "../quietButton";
import { Icon } from "./Icon";

/**
 * The reader's quiet button, kept small so the notice stays slim, with its touch target
 * grown to 44px by an invisible layer rather than by a taller pill.
 */
const NOTICE_BUTTON = `${QUIET_BUTTON} relative before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']`;

/**
 * "Sender pictures are off", at the top of the Inbox, between the demo strip (or the
 * briefing) and the first day. See `ui/pictureNotice.ts` for when it shows and why it
 * has two forms.
 *
 * Drawn like the reader's "Images are off" note (the same sheen panel, icon-led title,
 * muted line and quiet buttons), only slimmer: it heads a list, not a message. A
 * labelled region, so a screen reader can find it and skip it; the buttons keep their
 * visible words as their names, and point at the explanation for context.
 */
export function PictureNotice({
  kind,
  onKeepOff,
  onAct,
}: {
  kind: PictureNoticeKind;
  /** "Keep off" (or the profile prompt's "Not now"): answer for good, change nothing. */
  onKeepOff: () => void;
  /** "Turn on" (`off`), open Settings › Privacy (`paused`), or ask Google once (`profile`). */
  onAct: () => void;
}) {
  const id = useId();
  const copy = PICTURE_NOTICE_COPY[kind];
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-picture-notice={kind}
      className="mx-3 mb-2 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-pane bg-sheen px-3.5 py-2.5"
    >
      <div className="min-w-0 flex-[1_1_18rem]">
        <p id={`${id}-title`} className="flex items-center gap-2 text-ui font-semibold text-ink">
          <Icon icon={CircleUserRound} size={16} className="shrink-0 text-ink-muted" />
          {copy.title}
        </p>
        <p id={`${id}-body`} className="mt-0.5 text-meta leading-snug text-ink-muted">
          {copy.body}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={onKeepOff} aria-describedby={`${id}-body`} className={NOTICE_BUTTON}>
          {copy.keep}
        </button>
        <button type="button" onClick={onAct} aria-describedby={`${id}-body`} className={NOTICE_BUTTON}>
          {copy.act}
        </button>
      </div>
    </section>
  );
}
