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
 * **Sharing at dispatch.** Each file is shared with the message's recipients as
 * *reader*, without Drive's own notification email (the message carries the link). What
 * is shared is read off the body that goes out (`driveLinksForSend`): Winnow's own
 * "File name (size) — link" lines and any Drive file URL, plus the composer's
 * `driveFiles` whose line is still there — so a draft reopened from Gmail's Drafts, which
 * has lost the composer's list, still shares its links. `drive.file` reaches only files
 * Winnow created, so a 403/404 on a link that is *not* one of Winnow's lines (someone
 * else's Drive link pasted in) is skipped without a word; a failure on Winnow's own line
 * is reported per address before the message goes (`shareForSend`), so the user can
 * decide. Sharing happens when the message is actually dispatched — after the undo
 * window, or when the offline queue replays it — never when Send is tapped, and each
 * send records the permission ids it created (`DrivePermissionRef`), so a send that is
 * abandoned takes back exactly those (`revokeShares`) and nothing an earlier send made.
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
import { plainTextFromHtml } from "../mail/html";
import type { TokenProvider } from "./client";
import type { DraftDriveFile, DriveLinkRef, DrivePermissionRef } from "../model/email";

/** Only the files Winnow creates. Nothing else in the user's Drive. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

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


export type DriveFileInput = { filename: string; mimeType: string; bytes: Uint8Array };

/** A permission already on a file, as far as sharing needs to know. */
export type DrivePermission = { id: string; type: string; emailAddress?: string };

/** What both the real client and the demo's do. */
export interface DriveApi {
  upload(file: DriveFileInput, onProgress?: (fraction: number) => void): Promise<DriveFile>;
  /** Who can open the file already. Throws Google's answer (404 for a file not Winnow's). */
  permissions(fileId: string): Promise<DrivePermission[]>;
  /** Share with one address as a reader, without Drive's email. Resolves with the permission id. */
  share(fileId: string, email: string): Promise<string>;
  /** Take one permission back. A permission (or file) already gone is not an error. */
  revoke(fileId: string, permissionId: string): Promise<void>;
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

  async permissions(fileId: string): Promise<DrivePermission[]> {
    const { text } = await this.call(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,type,emailAddress)&pageSize=100`,
      { method: "GET" },
    );
    const parsed = JSON.parse(text || "{}") as { permissions?: DrivePermission[] };
    return (parsed.permissions ?? []).filter((permission) => typeof permission?.id === "string");
  }

  async share(fileId: string, email: string): Promise<string> {
    const { text } = await this.call(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false&fields=id`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ type: "user", role: "reader", emailAddress: email }),
      },
    );
    const parsed = JSON.parse(text || "{}") as { id?: string };
    if (!parsed.id) throw new GmailError("Google Drive did not return the permission it made.", 0, "unknown");
    return parsed.id;
  }

  async revoke(fileId: string, permissionId: string): Promise<void> {
    try {
      await this.call(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`, {
        method: "DELETE",
      });
    } catch (error) {
      // Already gone (the file deleted, or the permission removed by hand) is the goal.
      if (error instanceof GmailHttpError && (error.status === 404 || error.status === 410)) return;
      throw error;
    }
  }
}

/**
 * The demo's Drive: no network, ever. An upload "takes" a moment and answers with a
 * made-up link; sharing fails for an address at `example.invalid` (so the warning can be
 * tried) and succeeds for everything else.
 */
export class DemoDriveClient implements DriveApi {
  private next = 0;
  /** Permissions on the demo's own files, by file id. */
  private readonly shared = new Map<string, DrivePermission[]>();
  /** Every permission taken back, for the tests (and nothing else). */
  readonly revoked: string[] = [];
  constructor(private readonly delayMs = 400) {}

  async upload(file: DriveFileInput, onProgress?: (fraction: number) => void): Promise<DriveFile> {
    onProgress?.(0);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    onProgress?.(1);
    this.next += 1;
    const id = `demo-drive-${this.next}`;
    return { id, name: file.filename, size: file.bytes.byteLength, link: `https://drive.google.com/file/d/${id}/view` };
  }

  /** The demo "made" every `demo-drive-…` id; anything else is someone else's file. */
  private own(fileId: string): DrivePermission[] {
    if (!fileId.startsWith("demo-drive-")) throw new GmailHttpError(404, '{"error":{"code":404,"message":"File not found"}}');
    let list = this.shared.get(fileId);
    if (!list) this.shared.set(fileId, (list = []));
    return list;
  }

  async permissions(fileId: string): Promise<DrivePermission[]> {
    return [...this.own(fileId)];
  }

  async share(fileId: string, email: string): Promise<string> {
    const list = this.own(fileId);
    if (email.endsWith(".invalid")) {
      throw new GmailHttpError(400, '{"error":{"errors":[{"reason":"invalidSharingRequest"}]}}');
    }
    this.next += 1;
    const id = `demo-perm-${this.next}`;
    list.push({ id, type: "user", emailAddress: email });
    return id;
  }

  async revoke(fileId: string, permissionId: string): Promise<void> {
    const list = this.shared.get(fileId);
    if (list) this.shared.set(fileId, list.filter((permission) => permission.id !== permissionId));
    this.revoked.push(permissionId);
  }
}

/** The draft's Drive files whose line is still in the body. */
export function driveFilesToShare(
  body: string,
  files: readonly DriveFile[] | undefined,
): DriveFile[] {
  return (files ?? []).filter((file) => body.includes(driveLinkLine(file)));
}

// ── Links in a body ──────────────────────────────────────────────────────────

/** A Drive file id: Google's are long runs of these characters. */
const FILE_ID = "[A-Za-z0-9_-]{10,}";
const ID_IN_PATH = new RegExp(`/(?:file|document|spreadsheets|presentation|forms|drawings)/(?:u/\\d+/)?d/(?:e/)?(${FILE_ID})`);
const ID_IN_QUERY = new RegExp(`[?&]id=(${FILE_ID})`);
/** A Drive or Docs URL, up to where a sentence or markup would end it. */
const DRIVE_URL = /https?:\/\/(?:drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com)\/[^\s<>"'()\]]+/g;
/** Winnow's own line: "File name (size) — link", alone on its line. */
const OWN_LINE = /^(.+?) \((\d+(?:\.\d)? (?:B|KB|MB|GB))\) \u2014 (https:\/\/\S+)\s*$/;

/**
 * The file id in a Drive URL (`/file/d/<id>`, `open?id=<id>`, `uc?id=`, Docs' `/d/<id>`,
 * `drive.usercontent…?id=`), or `null` for anything else (a folder, another host).
 */
export function driveFileId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^(?:drive|docs|drive\.usercontent)\.google\.com$/.test(parsed.hostname)) return null;
  const tail = `${parsed.pathname}${parsed.search}`;
  if (/\/folders\//.test(parsed.pathname)) return null;
  return ID_IN_PATH.exec(tail)?.[1] ?? ID_IN_QUERY.exec(tail)?.[1] ?? null;
}

/** "26 MB" back to bytes, when `formatBytes` would write it again exactly. */
function bytesOf(label: string): number | null {
  const match = /^(\d+(?:\.\d)?) (B|KB|MB|GB)$/.exec(label);
  if (!match) return null;
  const power = { B: 0, KB: 1, MB: 2, GB: 3 }[match[2] as "B" | "KB" | "MB" | "GB"];
  const bytes = Math.round(Number(match[1]) * 1024 ** power);
  return formatBytes(bytes) === label ? bytes : null;
}

/** Winnow's own lines in a plain-text body, as the files they name. */
function ownLines(text: string): { id: string; name: string; label: string; link: string }[] {
  const out: { id: string; name: string; label: string; link: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = OWN_LINE.exec(line.trim());
    if (!match) continue;
    const id = driveFileId(match[3]!);
    if (id) out.push({ id, name: match[1]!, label: match[2]!, link: match[3]! });
  }
  return out;
}

/** `&amp;` and friends in an attribute, for an `href`. */
function decodeAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&#x0*26;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'");
}

/**
 * Every Drive file link in a message, once per file. `text` is the plain-text body;
 * `html`, when the message has one, is read too: its text (Winnow's lines survive
 * Gmail's editor as text with the URL linked) and every `href`. A link is `own` when it
 * sits on one of Winnow's "File name (size) — link" lines.
 */
export function findDriveLinks(text: string, html?: string): DriveLinkRef[] {
  const found = new Map<string, DriveLinkRef>();
  const add = (ref: DriveLinkRef) => {
    const known = found.get(ref.id);
    if (!known) found.set(ref.id, ref);
    else if (ref.own && !known.own) found.set(ref.id, { ...ref });
  };
  const texts = [text, ...(html ? [plainTextFromHtml(html)] : [])];
  for (const body of texts) {
    for (const line of ownLines(body)) add({ id: line.id, link: line.link, own: true, name: line.name });
    for (const match of body.matchAll(DRIVE_URL)) {
      const link = match[0].replace(/[.,;:!?]+$/, "");
      const id = driveFileId(link);
      if (id) add({ id, link, own: false });
    }
  }
  if (html) {
    for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const link = decodeAttribute(match[1] ?? match[2] ?? "");
      const id = driveFileId(link);
      if (id) add({ id, link, own: false });
    }
  }
  return [...found.values()];
}

/**
 * The files a draft reopened from Drafts names on Winnow's own lines, rebuilt as the
 * composer's `driveFiles` so their chips come back. Only lines whose size reads back
 * exactly, so the rebuilt line is the one in the body (and its × can take it out).
 */
export function recoverDriveFiles(text: string, html?: string): DriveFile[] {
  const out = new Map<string, DriveFile>();
  for (const body of [text, ...(html ? [plainTextFromHtml(html)] : [])]) {
    for (const line of ownLines(body)) {
      const size = bytesOf(line.label);
      if (size === null || out.has(line.id)) continue;
      const file = { id: line.id, name: line.name, size, link: line.link };
      if (text.includes(driveLinkLine(file))) out.set(line.id, file);
    }
  }
  return [...out.values()];
}

/**
 * What a send shares, read off the body that goes out: the composer's `driveFiles` whose
 * line is still there, Winnow's own lines, and any other Drive file link (not Winnow's,
 * as far as anyone can tell: tried, and skipped quietly if Drive refuses).
 */
export function driveLinksForSend(draft: { body: string; driveFiles?: readonly DriveFile[] }): DriveLinkRef[] {
  const out = new Map<string, DriveLinkRef>();
  for (const file of driveFilesToShare(draft.body, draft.driveFiles)) {
    out.set(file.id, { id: file.id, link: file.link, own: true, name: file.name });
  }
  for (const ref of findDriveLinks(draft.body)) {
    const known = out.get(ref.id);
    if (!known || (ref.own && !known.own)) out.set(ref.id, known ? { ...known, own: true } : ref);
  }
  return [...out.values()];
}

// ── Sharing at dispatch ─────────────────────────────────────────────────────

/** An address Drive would not share with, and which files it could not open. */
export type ShareProblem = { email: string; reason: string; files: string[] };

/** What one dispatch's sharing did: the permissions it made, and what failed on Winnow's own links. */
export type ShareOutcome = { created: DrivePermissionRef[]; problems: ShareProblem[] };

/** The API off, the scope gone, the session over: not about one link or one address. */
function wholeGrantFailure(error: unknown): boolean {
  if (error instanceof DriveApiDisabled || error instanceof DriveScopeMissing) return true;
  return error instanceof GmailError && error.kind === "reauth_required";
}

/** No HTTP answer at all: Drive could not be reached (offline). */
export function driveUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) return /fetch|network|load failed|connection/i.test(error.message);
  const shape = error as { name?: unknown; kind?: unknown } | null;
  return !!shape && (shape.name === "GoogleUnreachable" || shape.kind === "network" || shape.kind === "timeout");
}

/**
 * Share each link with every recipient as a reader, at dispatch.
 *
 * Who can already open a file is read first, and only the missing addresses are shared
 * with, so `created` is exactly what *this* send made (a permission an earlier send made
 * is never claimed, and so never taken back by this one). A file anyone with the link
 * can open needs nothing.
 *
 * A link that is not Winnow's (`own: false`) is skipped without a word on any refusal —
 * `drive.file` cannot reach someone else's file, which is a 404 (or 403), and that is
 * expected. A refusal on Winnow's own line is a `ShareProblem` per address. A failure
 * that is not about one link (API off, scope gone, signed out) or no answer at all is
 * thrown — after the permissions made so far are handed to `onCreated`, so the caller
 * can still account for them.
 */
export async function shareForSend(
  api: DriveApi,
  links: readonly DriveLinkRef[],
  recipients: readonly string[],
  onCreated?: (created: DrivePermissionRef[]) => void,
): Promise<ShareOutcome> {
  const created: DrivePermissionRef[] = [];
  const byEmail = new Map<string, ShareProblem>();
  const problem = (email: string, reason: string, name: string) => {
    const key = email.toLowerCase();
    const entry = byEmail.get(key) ?? { email, reason, files: [] };
    if (!entry.files.includes(name)) entry.files.push(name);
    byEmail.set(key, entry);
  };
  const people = [...new Set(recipients.map((email) => email.toLowerCase()))];
  try {
    if (people.length === 0) return { created, problems: [] };
    for (const link of links) {
      const name = link.name ?? link.link;
      let existing: DrivePermission[];
      try {
        existing = await api.permissions(link.id);
      } catch (error) {
        if (driveUnreachable(error)) throw error;
        if (!link.own) continue; // someone else's file: not Winnow's to share
        if (wholeGrantFailure(error)) throw error;
        const status = error instanceof GmailHttpError ? error.status : 0;
        const body = error instanceof GmailHttpError ? error.body : String(error);
        for (const email of people) problem(email, shareFailureReason(status, body), name);
        continue;
      }
      if (existing.some((permission) => permission.type === "anyone")) continue;
      const already = new Set(existing.map((permission) => (permission.emailAddress ?? "").toLowerCase()));
      for (const email of people) {
        if (already.has(email)) continue;
        try {
          const permissionId = await api.share(link.id, email);
          created.push({ fileId: link.id, permissionId, email });
        } catch (error) {
          if (driveUnreachable(error)) throw error;
          if (!link.own) break;
          if (wholeGrantFailure(error)) throw error;
          const status = error instanceof GmailHttpError ? error.status : 0;
          const body = error instanceof GmailHttpError ? error.body : String(error);
          problem(email, shareFailureReason(status, body), name);
        }
      }
    }
    return { created, problems: [...byEmail.values()] };
  } finally {
    onCreated?.(created);
  }
}

/**
 * Take back the permissions a send made, best effort, one at a time. Resolves with the
 * ones that could not be taken back (nothing is thrown: an abandoned send must not
 * become an error the user has to deal with).
 */
export async function revokeShares(api: DriveApi, created: readonly DrivePermissionRef[]): Promise<DrivePermissionRef[]> {
  const left: DrivePermissionRef[] = [];
  for (const permission of created) {
    try {
      await api.revoke(permission.fileId, permission.permissionId);
    } catch {
      left.push(permission);
    }
  }
  return left;
}

/** The dialog before a send whose Drive links Winnow is not allowed to share. */
export const DRIVE_GRANT_NEEDED = {
  title: "Allow Google Drive to share the links?",
  body:
    "This message has Google Drive links that Winnow uploaded, but Winnow isn't allowed to use Google Drive right now (it was signed out or the permission was removed), so it can't share them with the recipients.",
  sendAnywayWarning:
    "If you send anyway, the recipients may not be able to open the link.",
} as const;

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

