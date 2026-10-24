/**
 * Google account setup: the user's own OAuth client, as a five-step walkthrough.
 *
 * Winnow ships no Google client, so before anyone can connect Gmail they make one in
 * their own Google Cloud project and paste it in. The sheet walks them through it, one
 * console page at a time (`ui/googleSetupSteps` holds the steps and their links):
 *
 *   1. Create a project.            4. Create the client (Desktop app on the desktop
 *   2. Turn on the Gmail API           and Android builds, Web application on the web,
 *      (and People, optionally).       with the exact redirect URI the web needs).
 *   3. Consent screen + test user.  5. Paste or import it, test it, save and connect.
 *
 * Back/Next and the step indicator move freely between steps; nothing is lost on the
 * way, since the fields live in this component. It opens only when asked — Connect
 * Gmail, Continue with Google, Settings → Google account — never on its own: the app
 * always boots into the demo. With a client already stored it opens on step 5.
 *
 * Step 5 checks the format as you go (on blur, then on every keystroke once a field has
 * been flagged): the ID ends in `.apps.googleusercontent.com`, and a Web application
 * client needs a secret in Google's current format. "Test connection" asks Google
 * whether it knows the client without signing anyone in. Errors sit under their field
 * and are tied to it with `aria-describedby` and `aria-invalid`.
 *
 * "Import JSON" fills both fields from the file Google Cloud downloads for a client
 * (`client_secret_….json`): from a file picker, by dropping the file anywhere on the
 * sheet (at any step: it jumps to step 5), or by pasting the file's text into the client
 * ID field. `core/session/clientJson` does the parsing and refuses a client type this
 * host cannot use.
 *
 * Progress: Next ticks the step it leaves, and a half-finished setup (step, ticks and the
 * client ID draft, never the secret) is kept by `ui/setupProgress`, so reopening picks
 * up where the user left off, with "Start over" beside the note. Saving or removing the
 * client drops it. "Continue in demo" sits beside the progress line on every step while
 * no account is connected: setup is never a wall in front of the demo.
 *
 * Google's errors come back in plain words (`core/session/googleErrors`): a failed test
 * or sign-in gets a fix card with a link to the step that fixes it, and step 5's
 * "Google showed an error?" explains what was pasted off Google's own error pages
 * (`SetupTroubleshoot`). Step 3 lists the exact scopes, each with a copy button.
 *
 * On a phone the sheet fills the screen, with Back/Next pinned above the keyboard.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, Copy, ExternalLink, FileJson, RotateCcw, TriangleAlert } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import { ErrorText } from "./ErrorText";
import {
  CLIENT_ID_SUFFIX,
  CLIENT_SECRET_PREFIX,
  hasErrors,
  normaliseCredentials,
  validateCredentials,
  validateNativeClient,
  type ClientKind,
  type ConnectionTest,
  type CredentialErrors,
  type OAuthClientCredentials,
} from "../../core/session/credentials";
import {
  REQUIRED_APIS,
  apiLibraryUrl,
  looksLikeClientJson,
  parseClientJson,
  readClientJsonFile,
  type ClientJsonImport,
  type ClientJsonType,
} from "../../core/session/clientJson";
import {
  CONSOLE_LINKS,
  LOOPBACK_REDIRECT,
  SETUP_SCOPES,
  clampStep,
  clientTypeFor,
  initialSetupStep,
  originOf,
  pasteStepOf,
  setupSteps,
  type SetupStepId,
} from "../googleSetupSteps";
import { explainGoogleText } from "../../core/session/googleErrors";
import {
  clearSetupProgress,
  doneSummary,
  loadSetupProgress,
  markDone,
  saveSetupProgress,
} from "../setupProgress";
import { SetupFix, SetupTroubleshoot } from "./SetupTroubleshoot";
import type { AppSigningInfo } from "../../platform/types";
import { AndroidSignInStep } from "./AndroidSignInStep";

/** Where the setup guide lives. Opened in the system browser. */
export const SETUP_GUIDE_URL = "https://github.com/hxmbl/winnow/blob/master/docs/google-setup.md";

type Props = {
  kind: ClientKind;
  /** What is stored now, or `null` before setup. */
  current: OAuthClientCredentials | null;
  /** The redirect URI a web user registers (the app's own address). Empty on the desktop. */
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
  /** Open a Cloud Console link in the system browser. Defaults to a new tab. */
  onOpenLink?: (url: string) => void;
  onClose: () => void;
  /**
   * The Android app's package name and signing certificate, read at run time. Present
   * only in the Android app, where it adds the optional native sign-in step.
   */
  android?: AppSigningInfo | null;
};

/** What the last successful import brought in, shown under the import button. */
type Imported = { type: ClientJsonType; projectId?: string; warnings: string[] };

const FIELD =
  "w-full rounded-ctl border bg-surface px-4 py-1.5 font-mono text-ui text-ink outline-hidden placeholder:text-ink-placeholder focus-visible:border-accent max-sm:min-h-11 max-sm:text-read";
const PRIMARY =
  "rounded-ctl bg-accent px-4 py-1.5 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 aria-disabled:opacity-50 max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";
const LINK =
  "inline-flex w-fit items-center gap-1.5 rounded-ctl text-ui font-semibold text-ink-body underline underline-offset-2 hover:text-ink max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";
const SECONDARY =
  "rounded-ctl border border-control-border px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover aria-disabled:opacity-50 max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";

/** One numbered instruction inside a step. */
function Item({ children }: { children: React.ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

/** A name the user looks for in the console. */
function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink-body">{children}</strong>;
}

export function GoogleSetup(props: Props) {
  const { kind, current, phone } = props;
  const hasAndroid = Boolean(props.android);
  const steps = useMemo(() => setupSteps(hasAndroid), [hasAndroid]);
  const PASTE_STEP = pasteStepOf(steps);
  const ids = useId();
  const idField = `${ids}-client-id`;
  const secretField = `${ids}-client-secret`;

  /** A half-finished setup from an earlier visit (`ui/setupProgress`); never with a client stored. */
  const [resume] = useState(() => (current ? null : loadSetupProgress(kind)));
  const [clientId, setClientId] = useState(current?.clientId ?? resume?.clientId ?? "");
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
  const [imported, setImported] = useState<Imported | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /** A file is being dragged over the sheet. */
  const [dragging, setDragging] = useState(false);
  /** The walkthrough step on screen, 0-based. */
  const [step, setStep] = useState(() =>
    resume ? clampStep(resume.step, steps) : initialSetupStep(Boolean(current), steps),
  );
  /** Steps finished (left with Next), ticked on the indicator and remembered. */
  const [done, setDone] = useState<SetupStepId[]>(() => resume?.done ?? []);
  /** The "picking up where you left off" note, until it is dismissed or acted on. */
  const [resumed, setResumed] = useState(Boolean(resume));
  /** Off once the client is saved or removed, so a late render cannot write it back. */
  const tracking = useRef(!current);
  /** The optional Android step's Web client (native sign-in's `serverClientId`). */
  const [nativeId, setNativeId] = useState(current?.nativeAndroid?.clientId ?? "");
  const [nativeSecret, setNativeSecret] = useState(current?.nativeAndroid?.clientSecret ?? "");
  const [nativeShown, setNativeShown] = useState<{ clientId: boolean; clientSecret: boolean }>({
    clientId: false,
    clientSecret: false,
  });
  /**
   * The Android step arrives with the signing info, which is read once at start-up and
   * can land after the sheet opened: keep the same step on screen when the list grows.
   */
  const [shownSteps, setShownSteps] = useState(steps);
  if (shownSteps !== steps) {
    const index = steps.findIndex((item) => item.id === shownSteps[step]?.id);
    setShownSteps(steps);
    if (index >= 0 && index !== step) setStep(index);
  }
  const [copiedOrigin, setCopiedOrigin] = useState(false);
  const [copiedScope, setCopiedScope] = useState<string | null>(null);

  const idRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Set by Back, Next and the indicator: focus follows the user to the new step. */
  const stepMoved = useRef(false);
  /**
   * Where focus goes after the remove row swaps its buttons. The button that had focus
   * unmounts, and focus left on <body> is outside the sheet, where Escape and the Tab
   * trap cannot reach it.
   */
  const focusAfter = useRef<"keep" | "remove" | "clientId" | "import" | "submit" | null>(null);

  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "keep") keepRef.current?.focus();
    else if (target === "remove") removeRef.current?.focus();
    else if (target === "clientId") idRef.current?.focus();
    else if (target === "import") importRef.current?.focus();
    else if (target === "submit") submitRef.current?.focus();
  });

  // After Back/Next: the step's heading, so a screen reader reads where it landed, or
  // the client ID field on the step that is all about it.
  useEffect(() => {
    if (!stepMoved.current) return;
    stepMoved.current = false;
    if (step === PASTE_STEP) idRef.current?.focus();
    else headingRef.current?.focus();
  }, [step, PASTE_STEP]);

  function go(to: number) {
    stepMoved.current = true;
    setStep(clampStep(to, steps));
  }

  /** Next: this step is done, on to the following one. */
  function next() {
    setDone((list) => markDone(list, steps[step]!.id));
    go(step + 1);
  }

  function startOver() {
    clearSetupProgress();
    setDone([]);
    setResumed(false);
    setClientId("");
    setShown({ clientId: false, clientSecret: false });
    setRemote({});
    setTest(null);
    go(0);
  }

  // Remember a half-finished setup, so leaving for the console (or the demo) loses
  // nothing. The secret is never part of it.
  useEffect(() => {
    if (!tracking.current) return;
    saveSetupProgress({ step, done, kind, clientId });
  }, [step, done, kind, clientId]);

  const local = validateCredentials({ clientId, clientSecret }, kind);
  const nativeLocal: CredentialErrors = props.android
    ? validateNativeClient({ clientId: nativeId, clientSecret: nativeSecret }, clientId)
    : {};
  const nativeErrors: CredentialErrors = {
    clientId: nativeShown.clientId ? nativeLocal.clientId : undefined,
    clientSecret: nativeShown.clientSecret ? nativeLocal.clientSecret : undefined,
  };

  /**
   * What Test and Save send. On Android the native client comes from its step; anywhere
   * else a stored one is carried over untouched rather than dropped by a save.
   */
  function candidate(): OAuthClientCredentials {
    return normaliseCredentials({
      clientId,
      clientSecret,
      nativeAndroid: props.android ? { clientId: nativeId, clientSecret: nativeSecret } : current?.nativeAndroid,
    });
  }
  const errors: CredentialErrors = {
    clientId: (shown.clientId && local.clientId) || remote.clientId,
    clientSecret: (shown.clientSecret && local.clientSecret) || remote.clientSecret,
  };

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!copiedScope) return;
    const timer = setTimeout(() => setCopiedScope(null), 1500);
    return () => clearTimeout(timer);
  }, [copiedScope]);

  useEffect(() => {
    if (!copiedOrigin) return;
    const timer = setTimeout(() => setCopiedOrigin(false), 1500);
    return () => clearTimeout(timer);
  }, [copiedOrigin]);

  /** Validate everything; focus the first bad field. True when the form can go. */
  function ready(): boolean {
    setShown({ clientId: true, clientSecret: true });
    setNativeShown({ clientId: true, clientSecret: true });
    if (hasErrors(local)) {
      (local.clientId ? idRef : secretRef).current?.focus();
      return false;
    }
    if (hasErrors(nativeLocal)) {
      // The bad field is on the Android step: take the user there.
      go(steps.findIndex((item) => item.id === "android"));
      return false;
    }
    return true;
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
      applyTest(await props.onTest(candidate()));
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
    // The client is about to be stored where it belongs; the draft has done its job. The
    // web build leaves the page for Google here, so this cannot wait for the outcome.
    tracking.current = false;
    clearSetupProgress();
    try {
      await props.onSaveAndConnect(candidate());
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
      clearSetupProgress();
      setClientId("");
      setClientSecret("");
      setNativeId("");
      setNativeSecret("");
      setShown({ clientId: false, clientSecret: false });
      setNativeShown({ clientId: false, clientSecret: false });
      setConfirmRemove(false);
      setTest(null);
      setImported(null);
      setImportError(null);
      focusAfter.current = "clientId";
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The client could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Apply an import's outcome. On success both fields are filled and checked, and focus
   * moves to Save and connect, the next step; the summary is announced by its live
   * region. On failure the fields are left as they were and the error is announced.
   * The secret never reaches a message: the parser keeps it out of every one.
   */
  function applyImport(result: ClientJsonImport, from: "file" | "paste") {
    setFailure(null);
    setTest(null);
    setRemote({});
    if (!result.ok) {
      setImported(null);
      setImportError(result.error);
      focusAfter.current = from === "paste" ? "clientId" : "import";
      return;
    }
    setImportError(null);
    setClientId(result.credentials.clientId);
    setClientSecret(result.credentials.clientSecret ?? "");
    setShown({ clientId: true, clientSecret: true });
    setImported({ type: result.type, projectId: result.projectId, warnings: result.warnings });
    focusAfter.current = "submit";
  }

  const importContext = { kind, redirectUri: props.redirectUri };

  async function importFiles(files: FileList | File[] | null | undefined) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    if (list.length > 1) {
      setStep(PASTE_STEP);
      applyImport({ ok: false, error: "Drop one file: the client_secret_….json for your client." }, "file");
      return;
    }
    // A file dropped on an earlier step: the fields it fills are on the last one.
    setStep(PASTE_STEP);
    applyImport(await readClientJsonFile(list[0], importContext), "file");
  }

  function hasFiles(event: React.DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function openLink(url: string) {
    if (props.onOpenLink) props.onOpenLink(url);
    else globalThis.open?.(url, "_blank", "noopener,noreferrer");
  }

  async function copyText(text: string, done: () => void) {
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      done();
    } catch {
      // Clipboard refused (permissions, insecure origin). The value is selectable text.
    }
  }

  // Google's verdict, in plain words with the step that fixes it: from a failed sign-in,
  // or from a test that Google answered with something other than a field error.
  const failureHelp = failure ? explainGoogleText(failure, kind) : null;
  const testHelp = test && !test.ok && !test.field ? explainGoogleText(test.message, kind) : null;

  const secretRequired = kind === "web";
  const idHint = `${ids}-id-hint`;
  const idError = `${ids}-id-error`;
  const secretHint = `${ids}-secret-hint`;
  const secretError = `${ids}-secret-error`;
  const describedBy = (hint: string, error: string, has: boolean) =>
    has ? `${error} ${hint}` : hint;

  const device = kind === "desktop" ? "device" : "browser";
  const clientType = clientTypeFor(kind);
  const origin = originOf(props.redirectUri);
  const current_ = steps[step]!;
  const last = step === PASTE_STEP;
  const headingId = `${ids}-step-heading`;

  /** A link to one Cloud Console page, opened in the system browser. */
  const consoleLink = (url: string, label: string, testId: string, inline = false) => (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-console-link={testId}
      onClick={(event) => {
        event.preventDefault();
        openLink(url);
      }}
      className={inline ? LINK.replace(" max-sm:min-h-11", "") : LINK}
    >
      {label}
      <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
    </a>
  );


  /** A value to copy into the console, with a copy button. */
  const copyRow = (value: string, label: string, done: boolean, onCopy: () => void, testId: string) => (
    <div className="mt-1.5 flex items-center gap-2 rounded-ctl border border-hairline bg-surface px-2.5 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-meta text-ink" data-copy-value={testId}>
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={done ? `${label} copied` : `Copy ${label}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover max-sm:h-11 max-sm:w-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
  );

  const pasteStep = (
    <>
      <p>
        Paste the <Strong>{clientType}</Strong> client's details below, or import its JSON file. You
        can find it again under{" "}
        {consoleLink(CONSOLE_LINKS.clients, "Clients", "clients", true)} in your project.
      </p>

      <div
        className={`flex flex-col gap-2 rounded-pane border px-3 py-2.5 ${dragging ? "border-dashed border-accent bg-surface-hover" : "border-hairline bg-surface"}`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            ref={importRef}
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-describedby={`${ids}-import-hint`}
            className="inline-flex items-center gap-1.5 rounded-ctl border border-control-border px-3 py-1 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <FileJson size={14} strokeWidth={2} aria-hidden="true" />
            Import JSON
          </button>
          <p id={`${ids}-import-hint`} className="min-w-0 flex-1 text-meta text-ink-subtle">
            {dragging
              ? "Drop the client's JSON file to import it."
              : "Choose the client_secret_….json Google Cloud downloads, drop it here, or paste its text into Client ID."}
          </p>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true" data-import-status="">
          {imported && (
            <div className="flex flex-col gap-1.5 text-meta text-ink-body">
              <p className="flex items-start gap-1.5 font-medium text-success">
                <Check size={14} className="mt-px shrink-0" aria-hidden="true" />
                <span>
                  Imported the {imported.type === "installed" ? "Desktop app" : "Web application"} client
                  {imported.projectId ? (
                    <>
                      {" "}from project{" "}
                      <code className="font-mono text-ink" data-imported-project="">
                        {imported.projectId}
                      </code>
                    </>
                  ) : null}
                  . Check the fields, then save.
                </span>
              </p>
              {imported.warnings.map((warning) => (
                <p key={warning} className="flex items-start gap-1.5 text-ink-body" data-import-warning="">
                  <TriangleAlert size={14} className="mt-px shrink-0 text-danger" aria-hidden="true" />
                  <span className="selectable">{warning}</span>
                </p>
              ))}
              <p className="text-ink-subtle" data-api-note="">
                Also enable{" "}
                {REQUIRED_APIS.map((api, index) => {
                  const url = apiLibraryUrl(api.id, imported.projectId);
                  return (
                    <span key={api.id}>
                      {index > 0 ? " and " : ""}
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => {
                          event.preventDefault();
                          openLink(url);
                        }}
                        className="inline-flex items-center gap-0.5 rounded-ctl font-semibold text-ink-body underline underline-offset-2 hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        {api.name}
                        <ExternalLink size={11} aria-hidden="true" />
                      </a>
                      {api.required ? "" : ` (${api.purpose}, optional)`}
                    </span>
                  );
                })}{" "}
                {imported.projectId ? "for this project." : "for your project."}
              </p>
            </div>
          )}
        </div>
        {importError && (
          <p role="alert" className="text-meta font-medium text-danger" data-import-error="">
            <ErrorText text={importError} />
          </p>
        )}
      </div>

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
          onPaste={(event) => {
            // The whole client file pasted in: import it instead of filling the field.
            const text = event.clipboardData?.getData("text") ?? "";
            if (!looksLikeClientJson(text)) return;
            event.preventDefault();
            applyImport(parseClientJson(text, importContext), "paste");
          }}
          onChange={(event) => {
            const value = event.target.value;
            // A paste that arrived without a paste event (drag-in text, autofill).
            if (looksLikeClientJson(value) && value.trim().endsWith("}")) {
              applyImport(parseClientJson(value, importContext), "paste");
              return;
            }
            setClientId(value);
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
          It ends in {CLIENT_ID_SUFFIX}.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={secretField} className="text-ui font-medium text-ink-body">
          Client secret{" "}
          <span className="font-normal text-ink-subtle">{secretRequired ? "(required)" : "(optional)"}</span>
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
            : `Web application clients need it; it starts with ${CLIENT_SECRET_PREFIX}. It is kept in this browser only and sent to Google alone.`}
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
        {testHelp && <SetupFix help={testHelp} steps={steps} onGoToStep={go} />}
      </div>

      {failure && (
        <div role="alert" className="rounded-pane border border-hairline bg-danger-wash px-3 py-2.5 text-ui font-medium text-ink">
          <ErrorText text={failure} />
        </div>
      )}
      {failureHelp && <SetupFix help={failureHelp} steps={steps} onGoToStep={go} />}

      <SetupTroubleshoot kind={kind} steps={steps} onGoToStep={go} />

      <p className="text-meta leading-relaxed text-ink-subtle">
        {kind === "desktop"
          ? "Saved in your system's keychain. "
          : "Saved in this browser's local storage, on this site only. "}
        Winnow sends it to Google's sign-in and token endpoints and nowhere else.
        {props.signedIn && current ? " Changing it signs you out of Gmail." : ""}
      </p>

      {current && (
        <div className="border-t border-hairline-soft pt-4">
          {confirmRemove ? (
            <div className="flex flex-col gap-2" role="group" aria-label="Confirm removal">
              <p className="text-ui text-ink-body">
                Remove your Google client from this {device}?
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
                  className="rounded-ctl bg-danger px-4 py-1.5 text-ui font-semibold text-(--wn-surface) transition-opacity hover:opacity-90 aria-disabled:opacity-50 max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                className="shrink-0 rounded-ctl border border-control-border px-3 py-1 text-meta font-semibold text-danger transition-colors hover:bg-surface-hover max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Remove…
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );

  const body = (() => {
    switch (current_.id) {
      case "project":
        return (
          <>
            <p>
              Winnow doesn't come with a Google sign-in client. You make your own, in your own
              Google Cloud project, so your mail goes between this {device} and Google and nowhere
              else. It's free, needs no billing account, and takes about ten minutes the first time.
            </p>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5">
              <Item>Open Google Cloud and sign in with any Google account.</Item>
              <Item>
                Name the project <Strong>Winnow</Strong> and choose <Strong>Create</Strong>.
              </Item>
              <Item>Keep it selected in the project picker at the top: the next links open in it.</Item>
            </ol>
            {consoleLink(CONSOLE_LINKS.newProject, "Create a project", "project")}
            <p className="text-meta text-ink-subtle">Already have one? Select it in the console and choose Next.</p>
          </>
        );
      case "apis":
        return (
          <>
            <p>
              Winnow reads and sends your mail through the Gmail API, which a new project has turned
              off. Open its page and choose <Strong>Enable</Strong>.
            </p>
            {consoleLink(CONSOLE_LINKS.gmailApi, "Gmail API", "gmail-api")}
            <div className="flex flex-col gap-1.5 rounded-pane border border-hairline bg-surface px-3 py-2.5">
              <p className="text-meta font-medium text-ink-body">Optional: the People API</p>
              <p className="text-meta text-ink-subtle">
                For contact photos and recipient suggestions, which you can switch on later in Settings
                → Google contacts. Enabling it now saves a trip back.
              </p>
              {consoleLink(CONSOLE_LINKS.peopleApi, "People API", "people-api")}
            </div>
            <div data-setup-drive="" className="flex flex-col gap-1.5 rounded-pane border border-hairline bg-surface px-3 py-2.5">
              <p className="text-meta font-medium text-ink-body">Optional: the Google Drive API</p>
              <p className="text-meta text-ink-subtle">
                For sending files over Gmail's 25 MB as Drive links. Winnow only ever reaches the files it
                uploads for you, and asks the first time you use it. Skip it if you never send big files.
              </p>
              {consoleLink(CONSOLE_LINKS.driveApi, "Google Drive API", "drive-api")}
            </div>
          </>
        );
      case "consent":
        return (
          <>
            <p>
              Google shows a consent screen before it lets an app read mail. In the console it's called{" "}
              <Strong>Google Auth Platform</Strong>; choose <Strong>Get started</Strong> if it asks.
            </p>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5">
              <Item>
                App name <Strong>Winnow</Strong>, with your email as the support and contact address.
              </Item>
              <Item>
                Audience: <Strong>External</Strong>, and leave it in <Strong>Testing</Strong>.
              </Item>
              <Item>
                Under <Strong>Audience → Test users</Strong>, add the Gmail address you'll sign in with.
                While the app is in Testing, only test users can sign in.
              </Item>
              <Item>
                Under <Strong>Data access → Add or remove scopes</Strong>, paste these into{" "}
                <Strong>Manually add scopes</Strong>, then <Strong>Update</Strong> and <Strong>Save</Strong>.
              </Item>
            </ol>
            <ul className="flex flex-col gap-2" aria-label="Scopes" data-setup-scopes="">
              {SETUP_SCOPES.map((item) => (
                <li key={item.scope}>
                  <p className="text-meta text-ink-body">
                    {item.purpose}
                    <span className="text-ink-subtle">{item.required ? " (required)" : " (optional, for Google contacts)"}</span>
                  </p>
                  {copyRow(
                    item.scope,
                    `scope ${item.scope}`,
                    copiedScope === item.scope,
                    () => void copyText(item.scope, () => setCopiedScope(item.scope)),
                    `scope-${item.required ? "required" : "optional"}`,
                  )}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {consoleLink(CONSOLE_LINKS.consent, "Open the consent screen", "consent")}
              {consoleLink(CONSOLE_LINKS.testUsers, "Add test users", "test-users")}
              {consoleLink(CONSOLE_LINKS.scopes, "Add the scopes", "scopes")}
            </div>
            <p className="text-meta text-ink-subtle">
              In Testing, Google asks you to sign in again about once a week, and shows an “unverified
              app” warning at sign-in: choose Continue. It's your own app.
            </p>
          </>
        );
      case "client":
        return (
          <>
            <p>
              Choose <Strong>Create client</Strong>, and for <Strong>Application type</Strong> choose{" "}
              <Strong>{clientType}</Strong>.{" "}
              {kind === "desktop"
                ? "The desktop and Android apps sign in through a local address that Google allows only for this type."
                : "Winnow in a browser returns from Google to its own address, which only this type can register."}
            </p>
            {kind === "web" && props.redirectUri ? (
              <div className="flex flex-col gap-3" data-redirect-setup="">
                <div>
                  <p className="text-meta font-medium text-ink-body">Authorised redirect URIs: add exactly</p>
                  {copyRow(props.redirectUri, "redirect URI", copied, () => void copyText(props.redirectUri, () => setCopied(true)), "redirect")}
                </div>
                {origin && (
                  <div>
                    <p className="text-meta font-medium text-ink-body">Authorised JavaScript origins: add</p>
                    {copyRow(origin, "origin", copiedOrigin, () => void copyText(origin, () => setCopiedOrigin(true)), "origin")}
                  </div>
                )}
                <p className="text-meta text-ink-subtle">
                  This is the address this page is open at. They must match character for character,
                  trailing slash included: localhost and 127.0.0.1 are different addresses to Google.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5" data-redirect-setup="loopback">
                <p>
                  Name it <Strong>Winnow</Strong> and choose <Strong>Create</Strong>. There are no redirect
                  URIs to add: Winnow signs in through
                </p>
                {copyRow(LOOPBACK_REDIRECT, "loopback address", copied, () => void copyText(LOOPBACK_REDIRECT, () => setCopied(true)), "redirect")}
                <p className="text-meta text-ink-subtle">
                  on a port picked at sign-in, which a Desktop app client accepts without registering it.
                </p>
              </div>
            )}
            {consoleLink(CONSOLE_LINKS.newClient, "Create the client", "new-client")}
            <p className="text-meta text-ink-subtle">
              Google then shows the client ID and secret. Copy them, or choose{" "}
              <Strong>Download JSON</Strong> to import the file on the next step.
            </p>
          </>
        );
      case "android":
        return props.android ? (
          <AndroidSignInStep
            signing={props.android}
            clientId={nativeId}
            clientSecret={nativeSecret}
            onClientId={(value) => {
              setNativeId(value);
              setTest(null);
            }}
            onClientSecret={(value) => {
              setNativeSecret(value);
              setTest(null);
            }}
            errors={nativeErrors}
            onBlur={(field) =>
              setNativeShown((now) => ({ ...now, [field]: now[field] || Boolean(field === "clientId" ? nativeId : nativeSecret) }))
            }
            openLink={openLink}
            copyText={copyText}
            idPrefix={ids}
          />
        ) : null;
      case "paste":
        return pasteStep;
    }
  })();

  return (
    <Sheet
      label="Google account"
      onClose={props.onClose}
      // Holds typed credentials: a stray click outside should not throw them away.
      dismissOnBackdrop={false}
      initialFocus={last ? idRef : nextRef}
      placement={phone ? "fill" : "center"}
      className={
        phone
          ? "flex h-[calc(100dvh-var(--wn-keyboard,0px))] w-full flex-col overflow-hidden bg-chrome"
          : "flex max-h-[85vh] w-full max-w-[560px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome"
      }
    >
      <SheetHeader title="Google account" onClose={props.onClose} touch={phone} />
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // Enter in a field only ever means "save" on the step that has the fields.
          if (last) void connect(event);
        }}
        onDragEnter={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(event) => {
          // Leaving for a child is not leaving the sheet.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          void importFiles(event.dataTransfer.files);
        }}
        className={`flex min-h-0 flex-1 flex-col ${dragging ? "outline-dashed outline-2 -outline-offset-4 outline-accent" : ""}`}
        data-testid="google-setup"
        data-setup-step={current_.id}
        data-dragging={dragging || undefined}
      >
        <nav aria-label="Setup steps" className="border-b border-hairline-soft px-5 pb-3 pt-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-meta text-ink-subtle">
              <span data-setup-progress="">
                Step {step + 1} of {steps.length}
              </span>
              <span data-setup-done=""> · {doneSummary(done, steps)}</span>
            </p>
            {/* The demo is always one step away: setup is never a wall. */}
            {!props.signedIn && (
              <button
                type="button"
                onClick={props.onClose}
                className="shrink-0 rounded-ctl text-meta font-semibold text-ink-body underline underline-offset-2 hover:text-ink max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                data-setup-demo=""
              >
                Continue in demo
              </button>
            )}
          </div>
          <ol className="mt-2 flex items-start gap-1.5">
            {steps.map((item, index) => (
              <li key={item.id} className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => go(index)}
                  aria-current={index === step ? "step" : undefined}
                  aria-label={`Step ${index + 1}: ${item.title}${done.includes(item.id) ? " (done)" : ""}`}
                  data-done={done.includes(item.id) || undefined}
                  data-setup-step-button={item.id}
                  className="flex w-full flex-col gap-1.5 rounded-ctl py-1 text-left max-sm:min-h-11 max-sm:justify-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <span
                    aria-hidden="true"
                    className={`h-1 w-full rounded-full transition-colors ${
                      index === step || done.includes(item.id) ? "bg-accent" : "bg-hairline"
                    } ${index !== step && done.includes(item.id) ? "opacity-60" : ""}`}
                  />
                  <span
                    aria-hidden="true"
                    className={`flex min-w-0 items-center gap-1 text-meta max-sm:hidden ${index === step ? "font-semibold text-ink-body" : "text-ink-subtle"}`}
                  >
                    {done.includes(item.id) && <Check size={11} strokeWidth={2.5} className="shrink-0 text-accent" />}
                    <span className="truncate">{item.short}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div
          // Selectable, as one region: the steps, the redirect URI and the imported
          // project id are text a user copies into the Google Cloud console.
          data-select-scope=""
          className="selectable scroll-shadow thin-scroll min-h-0 flex-1 overflow-y-auto"
        >
          <section aria-labelledby={headingId} className="flex flex-col gap-3 px-5 py-4 text-ui leading-relaxed text-ink-muted">
            <h2
              ref={headingRef}
              id={headingId}
              tabIndex={-1}
              className="text-read font-semibold text-ink outline-hidden"
              data-setup-heading=""
            >
              {current_.title}
            </h2>
            {resumed && (
              <div
                className="flex items-center justify-between gap-3 rounded-pane border border-hairline bg-surface px-3 py-2 text-meta text-ink-body"
                data-setup-resumed=""
              >
                <span>Picking up where you left off.</span>
                <button
                  type="button"
                  onClick={startOver}
                  className="inline-flex shrink-0 items-center gap-1 rounded-ctl font-semibold text-ink-body underline underline-offset-2 hover:text-ink max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  Start over
                </button>
              </div>
            )}
            {body}
          </section>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            data-testid="google-setup-file"
            onChange={(event) => {
              const files = event.target.files;
              void importFiles(files ? Array.from(files) : null).finally(() => {
                // Let the same file be chosen again after a fix.
                if (fileRef.current) fileRef.current.value = "";
              });
            }}
          />
        </div>

        <div className="flex items-center gap-2 border-t border-hairline-soft px-5 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => go(step - 1)}
              className={`${SECONDARY} inline-flex items-center gap-1.5 ${last ? "max-sm:min-w-11 max-sm:justify-center max-sm:px-0" : ""}`}
            >
              <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
              {/* Icon-only on a phone's last step, so Test and Save fit on one row. */}
              <span className={last ? "max-sm:sr-only" : undefined}>Back</span>
            </button>
          ) : (
            <button type="button" onClick={props.onOpenGuide} className={`${LINK} text-meta`}>
              <BookOpen size={14} strokeWidth={2} aria-hidden="true" />
              Open the setup guide
            </button>
          )}
          <div className="ml-auto flex items-center justify-end gap-2">
            {last ? (
              <>
                {/*
                  aria-disabled rather than disabled while busy: disabling the focused button
                  would drop focus to <body>, outside the sheet, and Escape would stop working.
                */}
                <button type="button" onClick={() => void runTest()} aria-disabled={busy !== null} className={SECONDARY}>
                  {busy === "test" ? "Testing…" : "Test connection"}
                </button>
                <button ref={submitRef} type="submit" aria-disabled={busy !== null} className={PRIMARY}>
                  {busy === "connect" ? "Waiting for Google…" : "Save and connect"}
                </button>
              </>
            ) : (
              <button
                ref={nextRef}
                type="button"
                onClick={next}
                className={`${PRIMARY} inline-flex items-center gap-1.5`}
                data-setup-next=""
              >
                Next
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </form>
    </Sheet>
  );
}
