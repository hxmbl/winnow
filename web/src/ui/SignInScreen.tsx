/**
 * Sign-in.
 *
 * Two states and a lot of restraint. The screen has one job and asks for exactly one
 * scope, explained in one sentence in plain words rather than a URL.
 *
 * Failure copy is specific because sign-in fails for identifiable reasons, and a
 * generic "something went wrong" sends the user to the one place they cannot fix it.
 * `core/session/errors.ts` does the mapping; this component only renders it.
 *
 * Below the fold, the demo mailbox — not a consolation prize, but how you evaluate the
 * classification, which is Winnow's whole product.
 */

import { useEffect, useState } from "react";
import { AlertCircle, LogIn, Sparkles } from "lucide-react";
import { GMAIL_SCOPE } from "../core/gmail/dto";
import { describeFailure, type AuthFailure } from "../core/session/errors";
import { isTauri } from "../platform";
import { AppMark } from "./AppMark";
import { ErrorText } from "./components/ErrorText";

type Props = {
  /** Called to start sign-in. Resolves or throws; the throw is rendered below. */
  onSignIn: () => Promise<void>;
  onTryDemo: () => void;
  /** True when a session already exists and is being restored. */
  restoring: boolean;
  hasDemo: boolean;
  /** No OAuth client stored yet: the button opens the Google account setup first. */
  needsSetup?: boolean;
};

export function SignInScreen({ onSignIn, onTryDemo, restoring, hasDemo, needsSetup = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  // A failure from a previous attempt should not greet the user who just arrived.
  useEffect(() => setFailure(null), []);

  async function start() {
    setBusy(true);
    setFailure(null);
    try {
      await onSignIn();
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center text-center">
          <AppMark size={48} />
          <h1 className="mt-4 text-subject font-semibold text-ink">Winnow</h1>
          <p className="mt-2 max-w-[30ch] text-[13.5px] leading-relaxed text-ink-muted">
            An inbox that sorts itself. Winnow reads your mail, works out what is worth your
            attention, and puts the rest where you can deal with it later.
          </p>
        </div>

        {restoring ? (
          <p className="mt-8 text-center text-[13px] text-ink-subtle" role="status">
            Restoring your session…
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={start}
              disabled={busy}
              className="mt-8 flex w-full items-center justify-center gap-2 rounded-full bg-[var(--wn-inkBody)] px-4 py-2.5 text-[13.5px] font-semibold text-[var(--wn-surface)] transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <LogIn size={15} strokeWidth={2} aria-hidden="true" />
              {busy ? "Waiting for Google…" : needsSetup ? "Set up Google sign-in" : "Continue with Google"}
            </button>
            {needsSetup && (
              <p className="mt-2 text-center text-[12px] text-ink-subtle">
                Winnow uses a Google client from your own Cloud project. The setup takes about
                ten minutes the first time.
              </p>
            )}

            {failure && (
              <div
                role="alert"
                className="mt-3 rounded-pane border border-hairline bg-danger-wash px-4 py-3 text-left"
              >
                <div className="flex items-start gap-2 text-[13px] font-semibold text-ink">
                  <AlertCircle
                    size={15}
                    strokeWidth={2}
                    className="mt-px shrink-0 text-danger"
                    aria-hidden="true"
                  />
                  <ErrorText text={failure.message} />
                </div>
                {failure.hint && (
                  <div className="mt-1 pl-[23px] text-[12.5px] text-ink-muted">
                    <ErrorText text={failure.hint} />
                  </div>
                )}
              </div>
            )}

            <p className="mt-4 text-[12px] leading-relaxed text-ink-subtle">
              Winnow asks for read, send and label access to Gmail, and nothing else. It
              never reads or stores a password — sign-in happens in Google's own window.
              {isTauri() ? (
                <>
                  {" "}
                  Your access token is kept in your operating system's keychain, not on disk in
                  the app.
                </>
              ) : (
                <>
                  {" "}
                  Signing in here uses Google's web flow, so your session is stored in this
                  browser — use the desktop app if you want it in the OS keychain instead.
                </>
              )}
            </p>

            {hasDemo && (
              <>
                <div className="my-6 flex items-center gap-3">
                  <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
                  <span className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-ink-subtle">
                    or
                  </span>
                  <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
                </div>

                <button
                  type="button"
                  onClick={onTryDemo}
                  className="flex w-full items-center justify-center gap-2 rounded-full border border-control-border px-4 py-2.5 text-[13.5px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <Sparkles size={15} strokeWidth={1.9} aria-hidden="true" />
                  Look around the demo inbox
                </button>
                <p className="mt-2 text-center text-[12px] text-ink-subtle">
                  A sample mailbox with a message for every filter. Nothing leaves this device.
                </p>
              </>
            )}
          </>
        )}

        <details className="mt-8 text-[11.5px] text-ink-subtle">
          <summary className="cursor-pointer text-center hover:text-ink-muted">
            What exactly does Winnow ask for?
          </summary>
          <div className="mt-2 rounded-pane border border-hairline bg-surface p-3">
            <p className="font-mono text-[11px] break-all">{GMAIL_SCOPE}</p>
            <p className="mt-2">
              One scope, covering reading your mail, labelling it, and sending on your behalf.
              It is a single permission on purpose — asking for three would produce three
              warnings and tell you less, not more.
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
