/**
 * How long a sign-in keeps its "Waiting for Google…" state.
 *
 * Opening an account runs its whole first sync, and on a large mailbox that is minutes.
 * The sign-in buttons and the setup sheet used to wait for all of it, so Google had long
 * finished and the inbox was already filling while the sheet still said it was waiting
 * for Google. Sign-in is over once the account's mail is on screen: this resolves as soon
 * as the opened account shows its first message (cached or freshly synced), reaches a
 * settled state (ready, or an error the inbox itself shows), or the open finishes.
 *
 * A failure before any of that still rejects, so the caller can show it where the user
 * is looking. A failure after it is the inbox's to show, and is swallowed here.
 */

type MailSnapshot = {
  accountId: string | null;
  status: string;
  all: readonly unknown[];
};

export type MailStore = {
  getSnapshot(): MailSnapshot;
  subscribe(listener: () => void): () => void;
};

export function shownFor(snapshot: MailSnapshot, accountId: string): boolean {
  if (snapshot.accountId !== accountId) return false;
  return snapshot.all.length > 0 || snapshot.status === "ready" || snapshot.status === "error";
}

export function untilFirstMail(store: MailStore, accountId: string, opening: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (error?: unknown, failed = false) => {
      if (done) return;
      done = true;
      unsubscribe();
      if (failed) reject(error);
      else resolve();
    };
    unsubscribe = store.subscribe(() => {
      if (shownFor(store.getSnapshot(), accountId)) finish();
    });
    if (done) unsubscribe();
    opening.then(
      () => finish(),
      (error: unknown) => finish(error, true),
    );
    if (shownFor(store.getSnapshot(), accountId)) finish();
  });
}
