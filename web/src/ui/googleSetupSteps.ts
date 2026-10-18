/**
 * The Google client setup walkthrough: its steps, and the Cloud Console page each one
 * opens.
 *
 * Five steps, in the order Google's console makes you take them: a project, the Gmail
 * API (and optionally the People API), the consent screen with yourself as a test user,
 * the client itself, and pasting it into Winnow. The links go straight to the console
 * page for that step, so nobody has to find it through the console's menus; the console
 * opens them in whichever project is selected, which is why step 1 says to keep the new
 * one selected.
 *
 * The client type is the one choice that depends on the build: the desktop and Android
 * apps sign in through a loopback redirect, which Google allows only for a Desktop app
 * client, and the web build returns to its own address, which only a Web application
 * client can register. `docs/google-setup.md` is the long form of the same steps.
 */

import { apiLibraryUrl } from "../core/session/clientJson";
import { GMAIL_SCOPE } from "../core/gmail/dto";
import { CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE } from "../core/gmail/people";
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

export type SetupStepId = "project" | "apis" | "consent" | "client" | "paste";

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

/** The client type to choose in the console, as the console names it. */
export function clientTypeFor(kind: ClientKind): "Desktop app" | "Web application" {
  return kind === "desktop" ? "Desktop app" : "Web application";
}

/**
 * Where the walkthrough opens. Straight at the paste step when a client is already
 * stored (Settings → Google account → Change) — that user has done the console part —
 * and at the start otherwise.
 */
export function initialSetupStep(hasClient: boolean): number {
  return hasClient ? PASTE_STEP : 0;
}

/** A step index kept inside the walkthrough. */
export function clampStep(step: number): number {
  if (!Number.isFinite(step)) return 0;
  return Math.min(PASTE_STEP, Math.max(0, Math.trunc(step)));
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

/** The index of a step by id. */
export function stepIndexOf(id: SetupStepId): number {
  return Math.max(0, SETUP_STEPS.findIndex((step) => step.id === id));
}

/**
 * The scopes to add under Data access, exactly as Winnow asks for them. Gmail's one
 * scope covers reading, labels, drafts and sending; the two contact scopes are asked for
 * only when Google contacts is switched on in Settings.
 */
export const SETUP_SCOPES: readonly { scope: string; purpose: string; required: boolean }[] = [
  { scope: GMAIL_SCOPE, purpose: "Read, sort, draft and send your mail", required: true },
  { scope: CONTACTS_SCOPE, purpose: "Your contacts, for suggestions and photos", required: false },
  { scope: OTHER_CONTACTS_SCOPE, purpose: "People you've emailed, for suggestions", required: false },
];

/**
 * What the desktop and Android builds redirect to: a loopback address on a port picked at
 * sign-in. A Desktop app client accepts any loopback port without registering one, which
 * is why there is nothing to add in the console — shown so nobody goes looking.
 */
export const LOOPBACK_REDIRECT = "http://127.0.0.1";
