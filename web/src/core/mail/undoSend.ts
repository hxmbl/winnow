/**
 * Undo send: a message waits a few seconds after Send before it goes out, and Undo in
 * that window brings it back to the composer as it was.
 *
 * Nothing is sent and then recalled — Gmail has no recall. The message simply is not
 * sent until the delay ends, so Undo is exact: the draft never left.
 *
 * **If the app closes during the delay, the message is kept as a draft, not sent.**
 * The draft is saved (on this device at once, and to Gmail's Drafts) the moment Send
 * is pressed, so closing loses nothing; on the next launch the device copy is offered
 * back ("Restore your unsent draft?"). Sending from `pagehide` instead was rejected for
 * three reasons: a page that is closing cannot wait for a token refresh or a reply, so
 * "sent" could never be confirmed or its failure shown; Android may kill a backgrounded
 * webview without any unload event at all, so the send could not be relied on anyway;
 * and the user pressed a Send that promised a chance to change their mind — sending
 * early on the way out would take that chance away silently.
 *
 * Pure: the timers are handed in, so the window is testable without waiting.
 */

/**
 * The delays Settings → Compose → "Undo send window" offers, in seconds. `0` is Off:
 * Send sends at once. 10 s by default: long enough to notice a wrong recipient.
 */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number];
export const DEFAULT_UNDO_SEND_SECONDS: UndoSendSeconds = 10;

export function isUndoSendSeconds(value: unknown): value is UndoSendSeconds {
  return typeof value === "number" && (UNDO_SEND_CHOICES as readonly number[]).includes(value);
}

/**
 * A saved delay, read back. Builds up to 1.2.2 also offered 30 s; someone who chose
 * the longest wait keeps the longest one there is now rather than dropping to the
 * default. Anything else unknown is `null`, so the default applies.
 */
export function reviveUndoSendSeconds(value: unknown): UndoSendSeconds | null {
  if (isUndoSendSeconds(value)) return value;
  if (value === 30) return 20;
  return null;
}

/** What a choice reads as in Settings: `Off`, `5s`. */
export function undoSendLabel(seconds: UndoSendSeconds): string {
  return seconds === 0 ? "Off" : `${seconds}s`;
}

export type SendTimers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: SendTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One message waiting to go out. One at a time: a second Send while one waits sends
 * the first straight away rather than queueing it behind a timer nobody can see.
 */
export class DelayedSend<T> {
  private job: { value: T; run: (value: T) => void; handle: unknown; deadline: number } | null = null;

  constructor(
    private readonly timers: SendTimers = realTimers,
    private readonly now: () => number = Date.now,
  ) {}

  /** What is waiting, or `null`. */
  get pending(): T | null {
    return this.job?.value ?? null;
  }

  /** When the waiting message goes out, in ms since the epoch, or `null`. */
  get deadline(): number | null {
    return this.job?.deadline ?? null;
  }

  /**
   * Wait `delayMs`, then `run(value)`. A delay of zero or less runs it now. Anything
   * already waiting is sent first.
   */
  schedule(value: T, delayMs: number, run: (value: T) => void): void {
    this.sendNow();
    if (delayMs <= 0) {
      run(value);
      return;
    }
    const handle = this.timers.set(() => {
      const job = this.job;
      if (!job || job.handle !== handle) return;
      this.job = null;
      job.run(job.value);
    }, delayMs);
    this.job = { value, run, handle, deadline: this.now() + delayMs };
  }

  /** Undo: stop the waiting message and give it back, or `null` if it already went. */
  undo(): T | null {
    const job = this.job;
    if (!job) return null;
    this.timers.clear(job.handle);
    this.job = null;
    return job.value;
  }

  /** Send the waiting message now, if there is one. */
  sendNow(): void {
    const job = this.job;
    if (!job) return;
    this.timers.clear(job.handle);
    this.job = null;
    job.run(job.value);
  }
}
