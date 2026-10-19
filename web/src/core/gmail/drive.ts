/**
 * Large attachments as Google Drive links, the way Gmail does it.
 *
 * Gmail refuses a message whose attachments add up to more than 25 MB, and the Gmail API
 * has no "send it as a Drive link instead": the app has to upload the file, share it with
 * the recipients and put the link in the message. That is this module.
 *
 * **One scope, asked for late.** `drive.file` — the narrowest Drive scope there is. It
 * reaches only the files Winnow itself creates; it cannot list, open, change or delete
 * anything else in the user's Drive. It is requested incrementally the first time the
 * user chooses "Send as a Drive link" (`GmailSession.grantDrive`), never at sign-in, and
 * after a plain-words explanation (`DRIVE_CONSENT`). Whether it is granted is read off
 * the token, never stored separately, so signing out (which revokes the grant at Google)
 * or removing Winnow at Google leaves nothing behind.
 *
 * **Sharing.** Each file is shared with the message's recipients as *reader*, without
 * Drive's own notification email (the message carries the link). An address Drive will
 * not share with — usually one with no Google account — is reported before the message
 * is sent (`shareWith` answers per address), so the user can decide.
 *
 * **Bring-your-own client.** Users bring their own OAuth client, so the Drive API has to
 * be turned on in their Cloud project. Google's 403 for that is classified here
 * (`DriveApiDisabled`, with Google's own enable link), as the People API's is.
 *
 * The demo never calls Google: `DemoDriveClient` simulates the whole trip.
 */

import { GmailError, GmailHttpError } from "./dto";
import { apiActivationUrl, isApiDisabled, isScopeMissing } from "./people";
import { formatBytes } from "./mime";
import type { TokenProvider } from "./client";
import type { DraftDriveFile } from "../model/email";

/** Only the files Winnow creates. Nothing else in the user's Drive. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** The Drive API's page in the Cloud console, for when Google's error names no project. */
export const DRIVE_API_LIBRARY_URL = "https://console.cloud.google.com/apis/library/drive.googleapis.com";

/** Where the user can see, and remove, what Winnow may do with their Google account. */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/connections";

/** What the user is told before Google's consent screen, in plain words. */
export const DRIVE_CONSENT = {
  title: "Send big files as Google Drive links",
  allows: [
    "Upload the files you choose to send as links to your Google Drive",
    "Share each of those files with the people you send it to, so they can view it",
  ],
  doesNot: [
    "See, open, change or delete anything else in your Drive",
    "Upload anything you didn't choose to send",
  ],
  footnote:
    "Google will ask you to allow \u201cSee, edit, create and delete only the specific Google Drive files you use with this app\u201d. That is this, and nothing more. You can stop it any time in Settings \u2192 Privacy.",
} as const;

/** Whether a granted scope string includes `drive.file`. */
export function hasDriveScope(scope: string | undefined | null): boolean {
  return (scope ?? "").split(/\s+/).includes(DRIVE_FILE_SCOPE);
}

export type DriveAccess = "granted" | "not_granted" | "unavailable" | "demo";

/** The Drive API is turned off in the user's Cloud project. */
export class DriveApiDisabled extends GmailError {
  constructor(
    readonly activationUrl: string | null = null,
    message = "The Google Drive API is turned off in your Google Cloud project, so Winnow can't upload the file. Turn it on, then try again.",
  ) {
    super(message, 403, "unknown");
    this.name = "DriveApiDisabled";
  }
}

/** The token does not carry `drive.file` (never granted, or taken back at Google). */
export class DriveScopeMissing extends GmailError {
  constructor() {
    super("Winnow isn't allowed to upload to Google Drive. Allow it, then try again.", 403, "reauth_required");
    this.name = "DriveScopeMissing";
  }
}

/** What to tell the user about a failed Drive step, with a link when there is a switch to flip. */
export function driveFailureNotice(error: unknown): { message: string; url: string | null; label: string | null } {
  if (error instanceof Error && error.name === "DriveApiDisabled") {
    const url = (error as Partial<DriveApiDisabled>).activationUrl ?? null;
    return { message: error.message, url: url ?? DRIVE_API_LIBRARY_URL, label: "Turn on the Drive API" };
  }
  if (error instanceof Error && error.message) return { message: error.message, url: null, label: null };
  return { message: "The file couldn't be uploaded to Google Drive.", url: null, label: null };
}

/** An uploaded file (as the draft keeps it). */
export type DriveFile = DraftDriveFile;

/** One address Drive would not share with, and Google's reason in plain words. */
export type ShareFailure = { email: string; reason: string };

export type DriveFileInput = { filename: string; mimeType: string; bytes: Uint8Array };

/** What both the real client and the demo's do. */
export interface DriveApi {
  upload(file: DriveFileInput, onProgress?: (fraction: number) => void): Promise<DriveFile>;
  /** Share with each address as a reader. Resolves with the addresses that failed. */
  shareWith(fileId: string, emails: readonly string[]): Promise<ShareFailure[]>;
}

/** The line a Drive file adds to a plain-text body: "File name (size) — link". */
export function driveLinkLine(file: Pick<DriveFile, "name" | "size" | "link">): string {
  return `${file.name} (${formatBytes(file.size)}) \u2014 ${file.link}`;
}

/**
 * The body with the Drive links added at the end of what the user wrote (the quoted
 * reply is kept apart by the composer, so "the end" is above it), each on its own line
 * after a blank one. A link already in the body is not added twice.
 */
export function insertDriveLinks(body: string, files: readonly Pick<DriveFile, "name" | "size" | "link">[]): string {
  const lines = files.map(driveLinkLine).filter((line) => !body.includes(line));
  if (lines.length === 0) return body;
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? `${lines.join("\n")}\n` : `${trimmed}\n\n${lines.join("\n")}\n`;
}

/** Remove a file's line, for a Drive file taken off the message. */
export function removeDriveLink(body: string, file: Pick<DriveFile, "name" | "size" | "link">): string {
  const line = driveLinkLine(file);
  return body.replace(`\n\n${line}\n`, "\n").replace(`${line}\n`, "").replace(line, "");
}

/** Addresses from To/Cc/Bcc fields ("Ada <ada@x.co>, bob@y.co"), lower-cased and unique. */
export function recipientAddresses(...fields: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const field of fields) {
    for (const match of (field ?? "").matchAll(/[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g)) {
      out.add(match[0].toLowerCase());
    }
  }
  return [...out];
}

/** Google's refusal to share with one address, in words. */
export function shareFailureReason(status: number, body: string): string {
  if (/invalidSharingRequest|no Google account|not a valid|notify people/i.test(body)) {
    return "has no Google account Drive can share with";
  }
  if (/cannotShareTeamDriveWithNonGoogleAccounts|domainPolicy|sharingRateLimitExceeded|shareOutNotPermitted/i.test(body)) {
    return "can't receive shares from your account (a sharing policy)";
  }
  if (status === 404) return "the file is gone from Drive";
  return "Drive refused to share with this address";
}

export type DriveFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | Blob },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;

/** The Drive v3 REST client, on the session's tokens. */
export class DriveClient implements DriveApi {
  private readonly fetchImpl: DriveFetch;

  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly options: { fetchImpl?: DriveFetch; onUnauthorized?: () => Promise<string | null> } = {},
  ) {
    const impl = options.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as unknown as DriveFetch | undefined);
    if (!impl) throw new Error("no fetch implementation available");
    this.fetchImpl = impl;
  }

  /** One request, refreshed once on a 401, with the Drive failures classified. */
  private async call(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array | Blob },
  ): Promise<{ status: number; text: string; location: string | null }> {
    const token = await this.tokenProvider();
    if (!token) throw new GmailError("Not signed in to Google.", 401, "reauth_required");
    const send = async (bearer: string) => {
      const response = await this.fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${bearer}` } });
      return { response, text: await response.text() };
    };
    let { response, text } = await send(token);
    if (response.status === 401 && this.options.onUnauthorized) {
      const refreshed = await this.options.onUnauthorized();
      if (!refreshed) throw new GmailError("Your Google session has expired. Sign in again.", 401, "reauth_required");
      ({ response, text } = await send(refreshed));
    }
    if (!response.ok) {
      if (isApiDisabled(response.status, text)) throw new DriveApiDisabled(apiActivationUrl(text));
      if (isScopeMissing(response.status, text)) throw new DriveScopeMissing();
      throw new GmailHttpError(response.status, text);
    }
    return { status: response.status, text, location: response.headers.get("Location") ?? response.headers.get("location") };
  }

  /**
   * A resumable upload: one request with the metadata (name, type) that answers with an
   * upload address, then the bytes to it. Resumable rather than multipart because these
   * files are over 25 MB by definition, past what Google advises for a single request.
   */
  async upload(file: DriveFileInput, onProgress?: (fraction: number) => void): Promise<DriveFile> {
    const start = await this.call(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,size,webViewLink`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.mimeType || "application/octet-stream",
        "X-Upload-Content-Length": String(file.bytes.byteLength),
      },
      body: JSON.stringify({ name: file.filename, mimeType: file.mimeType || "application/octet-stream" }),
    });
    if (!start.location || !/^https:\/\/www\.googleapis\.com\/upload\/drive\//.test(start.location)) {
      throw new GmailError("Google Drive did not say where to upload the file.", 0, "unknown");
    }
    onProgress?.(0);
    const done = await this.call(start.location, {
      method: "PUT",
      headers: { "Content-Type": file.mimeType || "application/octet-stream" },
      body: file.bytes,
    });
    onProgress?.(1);
    const parsed = JSON.parse(done.text || "{}") as { id?: string; name?: string; webViewLink?: string };
    if (!parsed.id) throw new GmailError("Google Drive did not return the uploaded file.", 0, "unknown");
    return {
      id: parsed.id,
      name: parsed.name ?? file.filename,
      size: file.bytes.byteLength,
      link: parsed.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(parsed.id)}/view`,
    };
  }

  async shareWith(fileId: string, emails: readonly string[]): Promise<ShareFailure[]> {
    const failures: ShareFailure[] = [];
    for (const email of emails) {
      try {
        await this.call(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false&fields=id`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ type: "user", role: "reader", emailAddress: email }),
        });
      } catch (error) {
        // The API being off, the scope gone or the session over is not about one address.
        if (error instanceof DriveApiDisabled || error instanceof DriveScopeMissing) throw error;
        if (error instanceof GmailError && error.kind === "reauth_required") throw error;
        const status = error instanceof GmailHttpError ? error.status : 0;
        const body = error instanceof GmailHttpError ? error.body : String(error);
        failures.push({ email, reason: shareFailureReason(status, body) });
      }
    }
    return failures;
  }
}

/**
 * The demo's Drive: no network, ever. An upload "takes" a moment and answers with a
 * made-up link; sharing fails for an address at `example.invalid` (so the warning can be
 * tried) and succeeds for everything else.
 */
export class DemoDriveClient implements DriveApi {
  private next = 0;
  constructor(private readonly delayMs = 400) {}

  async upload(file: DriveFileInput, onProgress?: (fraction: number) => void): Promise<DriveFile> {
    onProgress?.(0);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    onProgress?.(1);
    this.next += 1;
    const id = `demo-drive-${this.next}`;
    return { id, name: file.filename, size: file.bytes.byteLength, link: `https://drive.google.com/file/d/${id}/view` };
  }

  async shareWith(_fileId: string, emails: readonly string[]): Promise<ShareFailure[]> {
    return emails
      .filter((email) => email.endsWith(".invalid"))
      .map((email) => ({ email, reason: "has no Google account Drive can share with" }));
  }
}

/** The draft's Drive files whose line is still in the body: the ones to share. */
export function driveFilesToShare(
  body: string,
  files: readonly DriveFile[] | undefined,
): DriveFile[] {
  return (files ?? []).filter((file) => body.includes(driveLinkLine(file)));
}

/** An address Drive would not share with, and which files it could not open. */
export type ShareProblem = { email: string; reason: string; files: string[] };

/**
 * Share each file with every recipient as a reader, and report per address what failed.
 * Called at send time, before the message leaves, so the user can be warned. A failure
 * that is not about one address (API off, scope gone, signed out) is thrown.
 */
export async function shareDriveFiles(
  api: DriveApi,
  files: readonly DriveFile[],
  recipients: readonly string[],
): Promise<ShareProblem[]> {
  const byEmail = new Map<string, ShareProblem>();
  if (recipients.length === 0) return [];
  for (const file of files) {
    for (const failure of await api.shareWith(file.id, recipients)) {
      const key = failure.email.toLowerCase();
      const problem = byEmail.get(key) ?? { email: failure.email, reason: failure.reason, files: [] };
      problem.files.push(file.name);
      byEmail.set(key, problem);
    }
  }
  return [...byEmail.values()];
}

/** The warning before send when some recipients can't open the Drive links. */
export function shareWarning(problems: readonly ShareProblem[]): { title: string; body: string } {
  const lines = problems.map((problem) => `${problem.email} ${problem.reason}`);
  const one = problems.length === 1;
  return {
    title: one ? "One recipient can't open the Drive link" : `${problems.length} recipients can't open the Drive links`,
    body:
      `${lines.join("; ")}. ` +
      (one ? "They will get the message, but the link won't open for them. " : "They will get the message, but the links won't open for them. ") +
      "Send anyway, or go back and attach a smaller file.",
  };
}

/**
 * Big files as Drive links: whether Google has granted `drive.file`, and Stop. Google
 * revokes a grant only whole (Gmail with it), so Stop is this device's switch, and the
 * permission itself goes with a sign-out or at Google's account page, which is linked.
 */
export function driveLinksStatus(access: DriveAccess | null, on: boolean): string {
  if (!on) return "Stopped on this device. The composer won't offer Drive links.";
  switch (access) {
    case "granted":
      return "Allowed by Google, only for the files Winnow uploads.";
    case "not_granted":
      return "Not allowed yet. Winnow asks the first time you send a big file as a link.";
    case "demo":
      return "Demo: nothing is uploaded.";
    default:
      return "Available once a Gmail account is connected.";
  }
}

