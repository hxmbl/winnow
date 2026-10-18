/**
 * The setup walkthrough's optional Android step: native sign-in.
 *
 * Shown only in the Android app, between creating the Desktop app client and pasting
 * it. It asks for two more clients in the same Cloud project:
 *
 *   1. an **Android** client registered with this app's package name and the SHA-1 of
 *      the certificate the running APK is signed with — both read from the phone, not
 *      typed from documentation, so a self-built APK shows its own;
 *   2. a **Web application** client, whose ID and secret are pasted here. Google issues
 *      native sign-in's authorization code to it (`serverClientId`), and it does the
 *      exchange and every refresh.
 *
 * Skipping it changes nothing: the browser sign-in works the same. Google allows one
 * package name and certificate pair in one Cloud project only, so with the official APK
 * the Android client may be refused as "already in use"; the step says so and points at
 * building Winnow yourself, which gives a certificate only you have.
 */

import { useState } from "react";
import { Check, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import { CLIENT_ID_SUFFIX, CLIENT_SECRET_PREFIX, type CredentialErrors } from "../../core/session/credentials";
import type { AppSigningInfo } from "../../platform/types";
import { CONSOLE_LINKS } from "../googleSetupSteps";

/** Where the self-build instructions live (native/README.md, "Android signing"). */
export const SELF_BUILD_GUIDE_URL = "https://github.com/hxmbl/winnow/blob/master/native/README.md#android-signing";

const FIELD =
  "w-full rounded-ctl border bg-surface px-2.5 py-1.5 font-mono text-ui text-ink outline-none placeholder:text-ink-placeholder focus-visible:border-accent max-sm:min-h-11 max-sm:text-read";
const LINK =
  "inline-flex w-fit items-center gap-1.5 rounded-ctl text-ui font-semibold text-ink-body underline underline-offset-2 hover:text-ink max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

type Props = {
  signing: AppSigningInfo;
  clientId: string;
  clientSecret: string;
  onClientId: (value: string) => void;
  onClientSecret: (value: string) => void;
  /** Errors to show now (touched or submitted fields only). */
  errors: CredentialErrors;
  /** Mark a field as touched, so its error shows. */
  onBlur: (field: "clientId" | "clientSecret") => void;
  openLink: (url: string) => void;
  copyText: (text: string, done: () => void) => Promise<void>;
  idPrefix: string;
};

function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink-body">{children}</strong>;
}

export function AndroidSignInStep(props: Props) {
  const { signing, errors, idPrefix } = props;
  const [copied, setCopied] = useState<"package" | "sha1" | null>(null);
  const idField = `${idPrefix}-native-id`;
  const secretField = `${idPrefix}-native-secret`;
  const idError = `${idPrefix}-native-id-error`;
  const secretError = `${idPrefix}-native-secret-error`;

  const link = (url: string, label: string, testId: string) => (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-console-link={testId}
      onClick={(event) => {
        event.preventDefault();
        props.openLink(url);
      }}
      className={LINK}
    >
      {label}
      <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
    </a>
  );

  const copyRow = (value: string, label: string, key: "package" | "sha1") => (
    <div className="mt-1.5 flex items-center gap-2 rounded-ctl border border-hairline bg-surface px-2.5 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-meta text-ink" data-copy-value={key}>
        {value}
      </code>
      <button
        type="button"
        onClick={() =>
          void props.copyText(value, () => {
            setCopied(key);
            setTimeout(() => setCopied((now) => (now === key ? null : now)), 1500);
          })
        }
        aria-label={copied === key ? `${label} copied` : `Copy ${label}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover max-sm:h-11 max-sm:w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {copied === key ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-android-step="">
      <p>
        With this, Winnow signs you in with Google's own account picker on this phone instead of a
        browser. It's optional: choose <Strong>Next</Strong> to skip it, and sign-in works through the
        browser as before. Winnow also uses the browser whenever the picker can't be used.
      </p>

      {!signing.playServices && (
        <p className="flex items-start gap-1.5 text-meta text-ink-body" data-android-no-play="">
          <TriangleAlert size={14} className="mt-px shrink-0 text-danger" aria-hidden="true" />
          <span>
            This phone doesn't have Google Play services, so Winnow will use the browser either way.
          </span>
        </p>
      )}

      <ol className="flex list-decimal flex-col gap-3 pl-5">
        <li className="pl-1">
          <p>
            In the same project, choose <Strong>Create client</Strong>, then <Strong>Android</Strong>,
            and enter:
          </p>
          <p className="mt-2 text-meta font-medium text-ink-body">Package name</p>
          {copyRow(signing.packageName, "package name", "package")}
          <p className="mt-2 text-meta font-medium text-ink-body">SHA-1 certificate fingerprint</p>
          {signing.sha1 ? (
            copyRow(signing.sha1, "SHA-1 fingerprint", "sha1")
          ) : (
            <p className="mt-1 text-meta text-danger" data-android-no-sha1="">
              Winnow couldn't read this app's signing certificate, so native sign-in can't be set up on
              this install.
            </p>
          )}
          <p className="mt-1.5 text-meta text-ink-subtle">
            Read from the app on this phone: it's the certificate this copy of Winnow is signed with.
          </p>
          <div className="mt-1.5">{link(CONSOLE_LINKS.newClient, "Create the Android client", "new-android-client")}</div>
        </li>
        <li className="pl-1">
          <p>
            Create one more client, of type <Strong>Web application</Strong>. Name it{" "}
            <Strong>Winnow Android</Strong>; it needs no origins or redirect URIs. Paste its ID and secret
            here.
          </p>
        </li>
      </ol>

      <div className="flex flex-col gap-1">
        <label htmlFor={idField} className="text-ui font-medium text-ink-body">
          Web client ID
        </label>
        <input
          id={idField}
          name="nativeClientId"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={props.clientId}
          placeholder={`1234567890-xyz789${CLIENT_ID_SUFFIX}`}
          onChange={(event) => props.onClientId(event.target.value)}
          onBlur={() => props.onBlur("clientId")}
          aria-invalid={errors.clientId ? true : undefined}
          aria-describedby={errors.clientId ? idError : undefined}
          className={`${FIELD} ${errors.clientId ? "border-danger" : "border-hairline"}`}
        />
        {errors.clientId && (
          <p id={idError} className="text-meta font-medium text-danger">
            {errors.clientId}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={secretField} className="text-ui font-medium text-ink-body">
          Web client secret
        </label>
        <input
          id={secretField}
          name="nativeClientSecret"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={props.clientSecret}
          onChange={(event) => props.onClientSecret(event.target.value)}
          onBlur={() => props.onBlur("clientSecret")}
          aria-invalid={errors.clientSecret ? true : undefined}
          aria-describedby={errors.clientSecret ? secretError : undefined}
          className={`${FIELD} ${errors.clientSecret ? "border-danger" : "border-hairline"}`}
        />
        {errors.clientSecret && (
          <p id={secretError} className="text-meta font-medium text-danger">
            {errors.clientSecret}
          </p>
        )}
        <p className="text-meta text-ink-subtle">
          It starts with {CLIENT_SECRET_PREFIX}. Kept in this phone's keystore and sent to Google alone.
          Clear both fields to turn native sign-in off.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-pane border border-hairline bg-surface px-3 py-2.5" data-android-in-use="">
        <p className="text-meta font-medium text-ink-body">
          Google says the package name and fingerprint are already in use?
        </p>
        <p className="text-meta text-ink-subtle">
          Google lets each package name and certificate pair belong to one Cloud project only, and
          every copy of the official APK has the same certificate, so someone else may have registered
          it first. Skip this step and use the browser, or build Winnow yourself with your own signing
          key: your build gets a fingerprint nobody else has, and this step shows it.
        </p>
        {link(SELF_BUILD_GUIDE_URL, "Build Winnow yourself", "self-build")}
      </div>
    </div>
  );
}
