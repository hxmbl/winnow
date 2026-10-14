/**
 * Google account setup: the user's own OAuth client.
 *
 * Winnow ships no Google client, so before anyone can connect Gmail they paste in the
 * client they created in their own Google Cloud project. This sheet is where that
 * happens, the first time someone presses "Connect Gmail" and again from Settings →
 * Google account to change or remove it.
 *
 * The form checks the format as you go (on blur, then on every keystroke once a field
 * has been flagged), and "Test connection" asks Google whether it knows the client
 * without signing anyone in. Errors sit under their field and are tied to it with
 * `aria-describedby` and `aria-invalid`, so a screen reader reads the problem with the
 * label.
 */

import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, Check, Copy } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import { ErrorText } from "./ErrorText";
import {
  CLIENT_ID_SUFFIX,
  hasErrors,
  normaliseCredentials,
  validateCredentials,
  type ClientKind,
  type ConnectionTest,
  type CredentialErrors,
  type OAuthClientCredentials,
} from "../../core/session/credentials";

/** Where the setup guide lives. Opened in the system browser. */
export const SETUP_GUIDE_URL = "https://github.com/hxmbl/winnow/blob/master/docs/google-setup.md";

type Props = {
  kind: ClientKind;
  /** What is stored now, or `null` before setup. */
  current: OAuthClientCredentials | null;
  /** The redirect URI a web user registers. Empty on the desktop. */
  redirectUri: string;
  /** Whether a Gmail account is connected right now (changing the client signs it out). */
  signedIn: boolean;
  /** Touch-sized targets and a full-width sheet. */
  phone: boolean;
  onTest: (credentials: OAuthClientCredentials) => Promise<ConnectionTest>;
  /** Save, then start the sign-in. Throws with a message to show when it fails. */
  onSaveAndConnect: (credentials: OAuthClientCredentials) => Promise<void>;
  onRemove: () => Promise<void>;
  onOpenGuide: () => void;
  onClose: () => void;
};

const FIELD =
  "w-full rounded-ctl border bg-surface px-2.5 py-1.5 font-mono text-ui text-ink outline-none placeholder:text-ink-placeholder focus-visible:border-accent max-sm:min-h-11 max-sm:text-read";
const PRIMARY =
  "rounded-ctl bg-accent px-4 py-1.5 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 aria-disabled:opacity-50 max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
const SECONDARY =
  "rounded-ctl border border-control-border px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover aria-disabled:opacity-50 max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

export function GoogleSetup(props: Props) {
  const { kind, current, phone } = props;
  const ids = useId();
  const idField = `${ids}-client-id`;
  const secretField = `${ids}-client-secret`;

  const [clientId, setClientId] = useState(current?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(current?.clientSecret ?? "");
  /** Fields whose errors are visible: touched (blurred) or submitted. */
  const [shown, setShown] = useState<{ clientId: boolean; clientSecret: boolean }>({
    clientId: false,
    clientSecret: false,
  });
  /** An error Google gave for one field, cleared when that field changes. */
  const [remote, setRemote] = useState<CredentialErrors>({});
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [busy, setBusy] = useState<"test" | "connect" | "remove" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);

  const idRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  /**
   * Where focus goes after the remove row swaps its buttons. The button that had focus
   * unmounts, and focus left on <body> is outside the sheet, where Escape and the Tab
   * trap cannot reach it.
   */
  const focusAfter = useRef<"keep" | "remove" | "clientId" | null>(null);

  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "keep") keepRef.current?.focus();
    else if (target === "remove") removeRef.current?.focus();
    else if (target === "clientId") idRef.current?.focus();
  });

  const local = validateCredentials({ clientId, clientSecret }, kind);
  const errors: CredentialErrors = {
    clientId: (shown.clientId && local.clientId) || remote.clientId,
    clientSecret: (shown.clientSecret && local.clientSecret) || remote.clientSecret,
  };

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  /** Validate everything; focus the first bad field. True when the form can go. */
  function ready(): boolean {
    setShown({ clientId: true, clientSecret: true });
    if (!hasErrors(local)) return true;
    (local.clientId ? idRef : secretRef).current?.focus();
    return false;
  }

  /** Put Google's verdict on the field it was about. */
  function applyTest(result: ConnectionTest) {
    setTest(result);
    if (!result.ok && result.field) setRemote({ [result.field]: result.message });
  }

  async function runTest() {
    if (busy) return;
    setFailure(null);
    setTest(null);
    setRemote({});
    if (!ready()) return;
    setBusy("test");
    try {
      applyTest(await props.onTest(normaliseCredentials({ clientId, clientSecret })));
    } finally {
      setBusy(null);
    }
  }

  async function connect(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setFailure(null);
    setRemote({});
    if (!ready()) return;
    setBusy("connect");
    try {
      await props.onSaveAndConnect(normaliseCredentials({ clientId, clientSecret }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The client could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setFailure(null);
    setBusy("remove");
    try {
      await props.onRemove();
      setClientId("");
      setClientSecret("");
      setShown({ clientId: false, clientSecret: false });
      setConfirmRemove(false);
      setTest(null);
      focusAfter.current = "clientId";
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The client could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  async function copyRedirect() {
    try {
      await globalThis.navigator?.clipboard?.writeText(props.redirectUri);
      setCopied(true);
    } catch {
      // Clipboard refused (permissions, insecure origin). The URI is selectable text.
    }
  }

  const secretRequired = kind === "web";
  const idHint = `${ids}-id-hint`;
  const idError = `${ids}-id-error`;
  const secretHint = `${ids}-secret-hint`;
  const secretError = `${ids}-secret-error`;
  const describedBy = (hint: string, error: string, has: boolean) =>
    has ? `${error} ${hint}` : hint;

  return (
    <Sheet
      label="Google account"
      onClose={props.onClose}
      // Holds typed credentials: a stray click outside should not throw them away.
      dismissOnBackdrop={false}
      initialFocus={idRef}
      placement={phone ? "fill" : "center"}
      className={
        phone
          ? "flex h-[calc(100dvh-var(--wn-keyboard,0px))] w-full flex-col overflow-hidden bg-chrome"
          : "flex max-h-[85vh] w-full max-w-[520px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome"
      }
    >
      <SheetHeader title="Google account" onClose={props.onClose} touch={phone} />
      <form
        noValidate
        onSubmit={(event) => void connect(event)}
        className="scroll-shadow thin-scroll min-h-0 flex-1 overflow-y-auto"
        data-testid="google-setup"
      >
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-2 text-ui leading-relaxed text-ink-muted">
            <p>
              Winnow doesn't come with a Google sign-in client. You use your own, made in your
              own Google Cloud project, so your mail goes between this{" "}
              {kind === "desktop" ? "computer" : "browser"} and Google and nowhere else.
            </p>
            <p>
              Create a client of type{" "}
              <strong className="font-semibold text-ink-body">
                {kind === "desktop" ? "Desktop app" : "Web application"}
              </strong>{" "}
              and paste its details below. It takes about ten minutes the first time.
            </p>
            <button
              type="button"
              onClick={props.onOpenGuide}
              className="inline-flex w-fit items-center gap-1.5 rounded-ctl text-ui font-semibold text-ink-body underline underline-offset-2 hover:text-ink max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <BookOpen size={14} strokeWidth={2} aria-hidden="true" />
              Open the setup guide
            </button>
          </div>

          {kind === "web" && props.redirectUri && (
            <div className="rounded-pane border border-hairline bg-surface px-3 py-2.5">
              <p className="text-meta font-medium text-ink-body">
                Add this as an authorised JavaScript origin and redirect URI
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-meta text-ink">
                  {props.redirectUri}
                </code>
                <button
                  type="button"
                  onClick={() => void copyRedirect()}
                  aria-label={copied ? "Redirect URI copied" : "Copy redirect URI"}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover max-sm:h-11 max-sm:w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                </button>
              </div>
              <p className="mt-1 text-meta text-ink-subtle">
                The origin is the same address without the trailing slash.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={idField} className="text-ui font-medium text-ink-body">
              Client ID
            </label>
            <input
              ref={idRef}
              id={idField}
              name="clientId"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={clientId}
              placeholder={`1234567890-abc123${CLIENT_ID_SUFFIX}`}
              onChange={(event) => {
                setClientId(event.target.value);
                setRemote((r) => ({ ...r, clientId: undefined }));
                setTest(null);
              }}
              onBlur={() => clientId && setShown((s) => ({ ...s, clientId: true }))}
              aria-invalid={errors.clientId ? true : undefined}
              aria-describedby={describedBy(idHint, idError, Boolean(errors.clientId))}
              className={`${FIELD} ${errors.clientId ? "border-danger" : "border-hairline"}`}
            />
            {errors.clientId && (
              <p id={idError} className="text-meta font-medium text-danger">
                {errors.clientId}
              </p>
            )}
            <p id={idHint} className="text-meta text-ink-subtle">
              Copy it from Google Auth Platform → Clients in your Cloud project.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={secretField} className="text-ui font-medium text-ink-body">
              Client secret{" "}
              <span className="font-normal text-ink-subtle">
                {secretRequired ? "(required)" : "(optional)"}
              </span>
            </label>
            <input
              ref={secretRef}
              id={secretField}
              name="clientSecret"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={clientSecret}
              onChange={(event) => {
                setClientSecret(event.target.value);
                setRemote((r) => ({ ...r, clientSecret: undefined }));
                setTest(null);
              }}
              onBlur={() => setShown((s) => ({ ...s, clientSecret: s.clientSecret || Boolean(clientSecret) }))}
              aria-required={secretRequired || undefined}
              aria-invalid={errors.clientSecret ? true : undefined}
              aria-describedby={describedBy(secretHint, secretError, Boolean(errors.clientSecret))}
              className={`${FIELD} ${errors.clientSecret ? "border-danger" : "border-hairline"}`}
            />
            {errors.clientSecret && (
              <p id={secretError} className="text-meta font-medium text-danger">
                {errors.clientSecret}
              </p>
            )}
            <p id={secretHint} className="text-meta text-ink-subtle">
              {kind === "desktop"
                ? "Paste it if Google shows one for your client. For a desktop app it isn't confidential, and it stays in your system keychain."
                : "Web application clients need it. It is kept in this browser only and sent to Google alone."}
            </p>
          </div>

          <div role="status" aria-live="polite" className="min-h-0 text-ui">
            {test?.ok && (
              <p className="flex items-start gap-1.5 font-medium text-success">
                <Check size={14} className="mt-px shrink-0" aria-hidden="true" />
                {test.message}
              </p>
            )}
            {test && !test.ok && !test.field && (
              <p className="font-medium text-danger">
                <ErrorText text={test.message} />
              </p>
            )}
          </div>

          {failure && (
            <div role="alert" className="rounded-pane border border-hairline bg-danger-wash px-3 py-2.5 text-ui font-medium text-ink">
              <ErrorText text={failure} />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {/*
              aria-disabled rather than disabled while busy: disabling the focused button
              would drop focus to <body>, outside the sheet, and Escape would stop working.
            */}
            <button type="button" onClick={() => void runTest()} aria-disabled={busy !== null} className={SECONDARY}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button type="submit" aria-disabled={busy !== null} className={PRIMARY}>
              {busy === "connect" ? "Waiting for Google…" : "Save and connect"}
            </button>
          </div>

          <p className="text-meta leading-relaxed text-ink-subtle">
            {kind === "desktop"
              ? "Saved in your operating system's keychain. "
              : "Saved in this browser's local storage, on this site only. "}
            Winnow sends it to Google's sign-in and token endpoints and nowhere else.
            {props.signedIn && current ? " Changing it signs you out of Gmail." : ""}
          </p>
        </div>

        {current && (
          <div className="border-t border-hairline-soft px-5 py-4">
            {confirmRemove ? (
              <div className="flex flex-col gap-2" role="group" aria-label="Confirm removal">
                <p className="text-ui text-ink-body">
                  Remove your Google client from this {kind === "desktop" ? "computer" : "browser"}?
                  {props.signedIn ? " This signs you out of Gmail and clears the cached mail." : ""}
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    ref={keepRef}
                    type="button"
                    onClick={() => {
                      focusAfter.current = "remove";
                      setConfirmRemove(false);
                    }}
                    className={SECONDARY}
                  >
                    Keep it
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove()}
                    aria-disabled={busy !== null}
                    className="rounded-ctl bg-danger px-4 py-1.5 text-ui font-semibold text-[var(--wn-surface)] transition-opacity hover:opacity-90 aria-disabled:opacity-50 max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    {busy === "remove" ? "Removing…" : props.signedIn ? "Remove and sign out" : "Remove"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-ui font-medium text-ink-body">Remove client</p>
                  <p className="text-meta text-ink-subtle">
                    {props.signedIn ? "Signs you out and forgets the client." : "Forgets the client on this device."}
                  </p>
                </div>
                <button
                  ref={removeRef}
                  type="button"
                  onClick={() => {
                    focusAfter.current = "keep";
                    setConfirmRemove(true);
                  }}
                  className="shrink-0 rounded-ctl border border-control-border px-3 py-1 text-meta font-semibold text-danger transition-colors hover:bg-surface-hover max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Remove…
                </button>
              </div>
            )}
          </div>
        )}
      </form>
    </Sheet>
  );
}
