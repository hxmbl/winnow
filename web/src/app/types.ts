/**
 * Types extracted from App.tsx
 */

import type { Draft, DrivePermissionRef, GmailId, Email } from "../core/model/email";
import type { WinnowStore } from "../core/store/store";
import type { MenuAnchor } from "../ui/menuPlacement";
import type { DriveDispatch } from "../core/gmail/driveSend";
import type { DraftSaveStatus } from "../core/mail/drafts";
import type { PlatformInfo } from "../platform/types";

/** Which popover menu is open, and what it acts on. */
export type OpenMenu = {
  kind: "sender" | "row";
  /** The message whose sender or row was clicked. */
  id: number;
  /** For a row menu: the messages it acts on (the selection, or just `id`). */
  ids: number[];
  anchor: MenuAnchor;
  /** Gets focus back when the menu closes by Escape or a choice. */
  trigger: HTMLElement | null;
};

export type Props = {
  /** The one piece of global state. Everything else is derived from it. */
  store: WinnowStore;
  /**
   * This device had run Winnow before this launch (any `winnow.*` key at boot), so the
   * first-run tour does not open by itself. Read in `main.tsx` before anything is written.
   */
  existingInstall?: boolean;
};

/**
 * The composer's state, including what it is for.
 *
 * `mode` drives the title and the body-field behaviour: a forward has no recipient until
 * the user picks one, a reply's does. It also matters to the Escape/discard logic, which
 * needs to know whether there is anything worth keeping.
 */
export type ComposerState = {
  draft: Draft;
  sending: boolean;
  error: string | null;
  mode: "reply" | "forward" | "new";
  /**
   * A new message's recipients and subject as it opened (blank, or from a `mailto:`),
   * so closing an untouched one does not ask. Replies and forwards judge by the body.
   */
  initial?: Pick<Draft, "to" | "cc" | "bcc" | "subject">;
  /** The message a reply or forward answers: where it docks, and what it threads on. */
  replyTo?: GmailId;
  /** Reply all (the default) or Reply, for a reply. */
  replyAll?: boolean;
  /** Which draft this is, for the autosave and the device copy. See `draftContextKey`. */
  context: string;
  /** What the autosave last said. */
  status: DraftSaveStatus;
  /**
   * Reopened from the Drafts mailbox: always a sheet (never docked, never parked by
   * the selection moving), closing keeps it rather than asking, and `baseline` is the
   * draft as it opened, so an untouched reopen neither re-saves nor counts as an edit.
   */
  fromDrafts?: { draftId: string; row: Email; baseline: Draft };
  /** Files a restored device copy could not bring back, said by the attachment area. */
  attachNotice?: string | null;
  /**
   * Drive permissions an attempt to send this message created and that are kept while it
   * might still go (a failed send, or the share warning waiting on an answer). Taken back
   * if the message is abandoned instead. See `core/gmail/driveSend`.
   */
  driveShares?: DrivePermissionRef[];
  /**
   * 1.4.0: the account it goes out from when that is not the open one (the From picker).
   * Absent: the open account, which is also the one a reply's original arrived in.
   */
  fromAccount?: string;
};

/**
 * A sent message waiting out its undo window: the composer as it was when Send was
 * pressed, its autosave (still attached to the Gmail draft), and the message a reply
 * threads on.
 */
export type PendingSend = {
  composer: ComposerState;
  saver: import("../core/mail/drafts").DraftAutosaver | null;
  inReplyTo?: GmailId;
  /** What the user already answered about its Drive links (Send anyway on either dialog). */
  drive?: SendDriveAnswers;
  /** The Drive permissions this message holds once dispatch has shared (set by `deliver`). */
  created?: DrivePermissionRef[];
  /** The Gmail draft to send when there is no autosave to ask (a scheduled send). */
  draftId?: string;
  /** A scheduled send going out: what the pill says, and whether it is late. */
  scheduled?: { sendAt: number; late: boolean };
};

/** Answers the user gave about a message's Drive links, carried into the send. */
export type SendDriveAnswers = { accepted?: boolean; waived?: boolean };

/** A send stopped at dispatch for the user to answer about its Drive links. */
export class DriveSendHold extends Error {
  constructor(readonly hold: Extract<DriveDispatch, { kind: "hold" }>) {
    super("The Drive links need an answer before this message goes.");
    this.name = "DriveSendHold";
  }
}

/** What `startComposer` is given: the composer, less the state it owns itself. */
export type ComposerStart = Omit<ComposerState, "sending" | "error" | "status">;

/**
 * Which account is active for demo mode
 */
export type DemoAccountType = "work" | "home";

/**
 * Platform info state
 */
export type PlatformInfoState = PlatformInfo | null;

export type PhoneConfirmState = {
  label: string;
  message: string;
  action: string;
  run: () => void;
} | null;

export type DriveConsentState = File[] | null;

export type DriveProblemState = { message: string; url: string | null; label: string | null } | null;

export type ConfirmSharesState = {
  recipients: Pick<Draft, "to" | "cc" | "bcc">;
  problems: import("../core/gmail/drive").ShareProblem[];
} | null;

export type ConfirmGrantState = {
  recipients: Pick<Draft, "to" | "cc" | "bcc">;
  immediate: boolean;
  /** Asked before a Send later to this time, not a Send. */
  at?: number;
} | null;

export type SnoozeMenuState = {
  ids: number[];
  anchor: MenuAnchor;
  trigger: HTMLElement | null;
} | null;

export type WhenPickerState = 
  | { kind: "snooze"; ids: number[] }
  | { kind: "send"; recipients: Pick<Draft, "to" | "cc" | "bcc"> }
  | null;

export type ConfirmNoSubjectState = (Pick<Draft, "to" | "cc" | "bcc"> & { at?: number }) | null;

export type FilterPickerState = number[] | null;

export type StepEnterState = { id: number; dir: "next" | "prev" } | null;
