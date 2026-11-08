import type { Snapshot, WinnowStore } from "../../core/store/store";
import { STORAGE_PROMPT, STORAGE_SAVE_FAILED } from "../../core/store/state";
import { CONNECTION_LOST } from "../../ui/offlineStatus";
import { ErrorText } from "../../ui/components/ErrorText";

type Props = {
  snapshot: Snapshot;
  online: boolean;
  store: WinnowStore;
};

/** App-wide connection, error, notice and offline-storage banners. */
export function AppNotices({ snapshot, online, store }: Props) {
  return (
    <>
      {snapshot.account !== null && (snapshot.connectionLost || !online) && (
        <div
          role="status"
          data-connection-lost=""
          className="flex items-center justify-center gap-2 bg-danger px-4 py-1.5 text-center text-meta font-semibold text-canvas"
        >
          <span className="min-w-0">{CONNECTION_LOST}</span>
        </div>
      )}

      {snapshot.error && (
        <div
          role="alert"
          data-error-banner=""
          className="flex items-start justify-between gap-3 border-b border-hairline bg-danger-wash px-4 py-1.5 text-meta font-medium text-ink-body"
        >
          {/*
            The whole error, selectable and with a Copy button: this is the text a user
            pastes into a search or a bug report, and a truncated line cannot be copied
            past its ellipsis.
          */}
          <ErrorText text={snapshot.error} className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={store.dismissError.bind(store)}
            className="shrink-0 font-semibold text-ink-subtle hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Dismiss
          </button>
        </div>
      )}

      {/*
        The notice strip.

        For what a sync told the user without it being a failure — a mailbox that hit its
        cap, so the view is a triage set rather than an export — which must not wear the
        alarming, dismissible banner of an error.
      */}
      {snapshot.notice && (
        <div className="flex items-center justify-between gap-3 border-b border-hairline-soft bg-notice px-4 py-1.5 text-meta font-medium text-ink-body">
          <span data-notice-text="" className="selectable min-w-0 truncate">{snapshot.notice}</span>
          <button
            type="button"
            onClick={store.dismissNotice.bind(store)}
            className="shrink-0 font-semibold text-ink-subtle hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Dismiss
          </button>
        </div>
      )}

      {/*
        The offline-storage question.

        A prompt, not a notice: the last sync could not write the offline cache, and the
        answer decides what happens — "Save" asks for persistent storage and retries the
        write, "Not now" keeps re-downloading on launch for the rest of this session.
      */}
      {snapshot.storagePrompt !== null && (
        <div
          role={snapshot.storagePrompt === "failed" ? "status" : "alertdialog"}
          aria-label="Save this mailbox offline"
          className="flex items-center justify-between gap-3 border-b border-hairline-soft bg-notice px-4 py-1.5 text-meta font-medium text-ink-body"
        >
          <span className="selectable min-w-0">
            {snapshot.storagePrompt === "failed" ? STORAGE_SAVE_FAILED : STORAGE_PROMPT}
          </span>
          {snapshot.storagePrompt === "failed" ? (
            <button
              type="button"
              onClick={store.dismissStoragePrompt.bind(store)}
              className="shrink-0 font-semibold text-ink-subtle hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Dismiss
            </button>
          ) : (
            <span className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                disabled={snapshot.storagePrompt === "saving"}
                onClick={() => void store.saveMailboxOffline()}
                className="font-semibold text-ink hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
              >
                {snapshot.storagePrompt === "saving" ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                disabled={snapshot.storagePrompt === "saving"}
                onClick={store.declineMailboxStorage.bind(store)}
                className="font-semibold text-ink-subtle hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
              >
                Not now
              </button>
            </span>
          )}
        </div>
      )}
    </>
  );
}
