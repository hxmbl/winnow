/**
 * The inbox's "Sender pictures are off" notice: whether it shows, and which one.
 *
 * Modelled on the reader's "Images are off" note (`core/mail/imageConsent.ts`): a
 * privacy default is explained once, where its effect is seen, with the choice beside
 * it. Sender pictures (Gravatar and brand logos, `Preferences.senderPictures`) are off
 * by default, so a new inbox is a column of initials with no word about why; this says
 * why, and what turning them on would send.
 *
 * Two notices, because two different things can be keeping the pictures away:
 *
 * - `off` — the switch is off. "Turn on" flips it, and nothing else.
 * - `paused` — Remote images is set to Never, which pauses sender pictures whatever the
 *   switch says. The notice says so, and its second button opens Settings › Privacy
 *   instead of turning anything on: loosening Remote images from here would quietly
 *   undo a stronger privacy choice the user made on purpose, and turning only the
 *   switch on would change nothing they could see.
 *
 * Answered for good by "Keep off", by "Turn on", or by changing the switch in Settings
 * (`pictureNoticeDismissed`). Only in the Inbox, with mail in it: the empty screens have
 * their own message, and other mailboxes are not where the question was asked.
 */

import type { ImagePolicy } from "../core/store/store";

/**
 * `profile` is not about sender pictures: it is the one-time prompt for the open
 * account's own Google picture (STRM-461) when its session is from before Winnow asked
 * for the basic profile. It shares the slot (one notice at a time, the sender-pictures
 * ones first) and the look. Its first button only puts it aside, for good: there is no
 * setting, and the profile is still asked for on the next trip to Google.
 */
export type PictureNoticeKind = "off" | "paused" | "profile";

export type PictureNoticeInput = {
  senderPictures: boolean;
  imagePolicy: ImagePolicy;
  dismissed: boolean;
  /** The mailbox or label on screen. */
  mailbox: string;
  /** Rows in the list as shown (after filters and search). */
  rowCount: number;
};

/** Which notice heads the list, or null for none. */
export function pictureNotice({
  senderPictures,
  imagePolicy,
  dismissed,
  mailbox,
  rowCount,
}: PictureNoticeInput): PictureNoticeKind | null {
  if (dismissed) return null;
  if (mailbox !== "inbox" || rowCount === 0) return null;
  // Never is checked first: with it, the switch alone cannot bring a picture back.
  if (imagePolicy === "never") return "paused";
  if (!senderPictures) return "off";
  return null;
}

/** The words, kept beside the rule so tests and screenshots read the same copy. */
export const PICTURE_NOTICE_COPY: Record<PictureNoticeKind, { title: string; body: string; keep: string; act: string }> = {
  off: {
    title: "Sender pictures are off",
    body: "Turning them on sends Gravatar a hash of each sender's address and looks up their domain for a logo.",
    keep: "Keep off",
    act: "Turn on",
  },
  paused: {
    title: "Sender pictures are paused",
    body: "Remote images is set to Never, which pauses Gravatar photos and brand logos too.",
    keep: "Keep off",
    act: "Open Privacy settings",
  },
  profile: {
    title: "Show your Google profile picture",
    body: "Google needs you to confirm it once; your mail and settings stay as they are.",
    keep: "Not now",
    act: "Continue",
  },
};
