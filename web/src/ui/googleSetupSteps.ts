/**
 * The Google client setup walkthrough: its steps, and the Cloud Console page each one
 * opens.
 *
 * Five steps, in the order Google's console makes you take them: a project, the Gmail
 * API (and optionally the People and Drive APIs), the consent screen with yourself as a test user,
 * the client itself, and pasting it into Winnow. The links go straight to the console
 * page for that step, so nobody has to find it through the console's menus; the console
 * opens them in whichever project is selected, which is why step 1 says to keep the new
 * one selected.
 *
 * The client type is the one choice that depends on the build: the desktop and Android
 * apps sign in through a loopback redirect, which Google allows only for a Desktop app
 * client, and the web build returns to its own address, which only a Web application
 * client can register. `docs/google-setup.md` is the long form of the same steps.
 *
 * Android adds one optional step before the paste (`ANDROID_STEP`), for native sign-in.
 */

import { apiLibraryUrl } from "../core/session/clientJson";
import { GMAIL_SCOPE, PROFILE_SCOPE } from "../core/gmail/dto";
import { CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE } from "../core/gmail/people";
import { DRIVE_FILE_SCOPE } from "../core/gmail/drive";
import type { ClientKind } from "../core/session/credentials";

const CONSOLE = "https://console.cloud.google.com";

/** Every console page the walkthrough links to. */
export const CONSOLE_LINKS = {
  /** A new project. */
  newProject: `${CONSOLE}/projectcreate`,
  /** The Gmail API's page, with its Enable button. */
  gmailApi: apiLibraryUrl("gmail.googleapis.com"),
  /** The People API's page: optional, for contact photos and suggestions. */
  peopleApi: apiLibraryUrl("people.googleapis.com"),
  /** The Drive API's page: optional, for sending files over 25 MB as Drive links. */
  driveApi: apiLibraryUrl("drive.googleapis.com"),
  /** The OAuth consent screen (now "Google Auth Platform"; the old address forwards). */
  consent: `${CONSOLE}/apis/credentials/consent`,
  /** Google Auth Platform → Data access, where the scopes are added. */
  scopes: `${CONSOLE}/auth/scopes`,
  /** Google Auth Platform → Audience, where test users are added. */
  testUsers: `${CONSOLE}/auth/audience`,
  /** Create an OAuth client. */
  newClient: `${CONSOLE}/apis/credentials/oauthclient`,
  /** The project's clients, to find one made before. */
  clients: `${CONSOLE}/auth/clients`,
} as const;

export type SetupStepId = "project" | "apis" | "consent" | "client" | "android" | "paste";

export type SetupStep = {
  id: SetupStepId;
  /** Short, for the step indicator. */
  short: string;
  /** The step's heading. */
  title: string;
};

export const SETUP_STEPS: readonly SetupStep[] = [
  { id: "project", short: "Project", title: "Create a Google Cloud project" },
  { id: "apis", short: "Gmail API", title: "Turn on the Gmail API" },
  { id: "consent", short: "Consent", title: "Set up the consent screen" },
  { id: "client", short: "Client", title: "Create the OAuth client" },
  { id: "paste", short: "Paste", title: "Paste your client into Winnow" },
];

/** The last step, where the client is pasted or imported. */
export const PASTE_STEP = SETUP_STEPS.length - 1;

/**
 * Android's optional extra step, before the paste step: an Android client (package name
 * and the running APK's signing certificate) and the Web application client native
 * sign-in names as its `serverClientId`. Skippable; the browser sign-in needs none of it.
 */
export const ANDROID_STEP: SetupStep = {
  id: "android",
  short: "Android",
  title: "Optional: sign in without the browser",
};

/** The walkthrough for this build: the five steps, plus the Android one on Android. */
export function setupSteps(android: boolean): readonly SetupStep[] {
  if (!android) return SETUP_STEPS;
  return [...SETUP_STEPS.slice(0, PASTE_STEP), ANDROID_STEP, SETUP_STEPS[PASTE_STEP]!];
}

/** Every step any build shows, in order: the bound a remembered step is kept within. */
export const ALL_SETUP_STEPS: readonly SetupStep[] = setupSteps(true);

/** The paste step's index in `steps`: always the last. */
export function pasteStepOf(steps: readonly SetupStep[]): number {
  return steps.length - 1;
}

/** The client type to choose in the console, as the console names it. */
export function clientTypeFor(kind: ClientKind): "Desktop app" | "Web application" {
  return kind === "desktop" ? "Desktop app" : "Web application";
}

/**
 * Where the walkthrough opens. Straight at the paste step when a client is already
 * stored (Settings → Google account → Change) — that user has done the console part —
 * and at the start otherwise.
 */
export function initialSetupStep(hasClient: boolean, steps: readonly SetupStep[] = SETUP_STEPS): number {
  return hasClient ? pasteStepOf(steps) : 0;
}

/** A step index kept inside the walkthrough. */
export function clampStep(step: number, steps: readonly SetupStep[] = SETUP_STEPS): number {
  if (!Number.isFinite(step)) return 0;
  return Math.min(pasteStepOf(steps), Math.max(0, Math.trunc(step)));
}

/**
 * The JavaScript origin a Web application client registers: the redirect URI's origin,
 * which the console wants without a path or trailing slash. Empty when there is none.
 */
export function originOf(redirectUri: string): string {
  try {
    return redirectUri ? new URL(redirectUri).origin : "";
  } catch {
    return "";
  }
}

/** The index of a step by id, in `steps` (the walkthrough on screen). */
export function stepIndexOf(id: SetupStepId, steps: readonly SetupStep[] = SETUP_STEPS): number {
  return Math.max(0, steps.findIndex((step) => step.id === id));
}

/**
 * The scopes to add under Data access, exactly as Winnow asks for them. Gmail's one
 * scope covers reading, labels, drafts and sending; the basic profile (non-sensitive,
 * nothing to verify) is the account's own picture, also asked for at sign-in; the two contact scopes are asked for
 * only when Google contacts is switched on in Settings, and `drive.file` only the first
 * time a file over 25 MB is sent as a Drive link.
 */
export const SETUP_SCOPES: readonly { scope: string; purpose: string; required: boolean }[] = [
  { scope: GMAIL_SCOPE, purpose: "Read, sort, draft and send your mail", required: true },
  { scope: PROFILE_SCOPE, purpose: "Your name and profile picture, for your account", required: true },
  { scope: CONTACTS_SCOPE, purpose: "Your contacts, for suggestions and photos", required: false },
  { scope: OTHER_CONTACTS_SCOPE, purpose: "People you've emailed, for suggestions", required: false },
  { scope: DRIVE_FILE_SCOPE, purpose: "Only the files you send as Drive links", required: false },
];

/**
 * What the desktop and Android builds redirect to: a loopback address on a port picked at
 * sign-in. A Desktop app client accepts any loopback port without registering one, which
 * is why there is nothing to add in the console — shown so nobody goes looking.
 */
export const LOOPBACK_REDIRECT = "http://127.0.0.1";
