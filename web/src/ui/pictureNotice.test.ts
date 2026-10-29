import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../core/store/store";
import { PICTURE_NOTICE_COPY, pictureNotice, type PictureNoticeInput } from "./pictureNotice";

const base: PictureNoticeInput = {
  senderPictures: false,
  imagePolicy: "ask",
  dismissed: false,
  mailbox: "inbox",
  rowCount: 12,
};

describe("the Sender pictures notice", () => {
  it("shows on a fresh install's inbox, where the defaults leave pictures off", () => {
    expect(
      pictureNotice({
        ...base,
        senderPictures: DEFAULT_PREFERENCES.senderPictures,
        imagePolicy: DEFAULT_PREFERENCES.imagePolicy,
        dismissed: DEFAULT_PREFERENCES.pictureNoticeDismissed,
      }),
    ).toBe("off");
  });

  it("shows with Remote images set to Always too: the switch is still off", () => {
    expect(pictureNotice({ ...base, imagePolicy: "always" })).toBe("off");
  });

  it("is gone once sender pictures are on", () => {
    expect(pictureNotice({ ...base, senderPictures: true })).toBeNull();
    expect(pictureNotice({ ...base, senderPictures: true, imagePolicy: "always" })).toBeNull();
  });

  it("says paused, not off, when Remote images = Never is what keeps them away", () => {
    expect(pictureNotice({ ...base, imagePolicy: "never" })).toBe("paused");
    // The switch on does not help while Never stands, so the notice still explains it.
    expect(pictureNotice({ ...base, senderPictures: true, imagePolicy: "never" })).toBe("paused");
  });

  it("never comes back once answered", () => {
    expect(pictureNotice({ ...base, dismissed: true })).toBeNull();
    expect(pictureNotice({ ...base, dismissed: true, imagePolicy: "never" })).toBeNull();
  });

  it("only heads the Inbox, and only when it has mail", () => {
    for (const mailbox of ["archive", "sent", "drafts", "trash", "spam", "snoozed", "scheduled", "Label_42"]) {
      expect(pictureNotice({ ...base, mailbox })).toBeNull();
    }
    expect(pictureNotice({ ...base, rowCount: 0 })).toBeNull();
  });

  it("names the trade-off honestly, and never offers to loosen Remote images", () => {
    expect(PICTURE_NOTICE_COPY.off.body).toMatch(/Gravatar a hash of each sender's address/);
    expect(PICTURE_NOTICE_COPY.off.body).toMatch(/domain for a logo/);
    expect(PICTURE_NOTICE_COPY.off.act).toBe("Turn on");
    expect(PICTURE_NOTICE_COPY.paused.body).toMatch(/Remote images is set to Never/);
    expect(PICTURE_NOTICE_COPY.paused.act).not.toMatch(/turn on|allow|images/i);
    // The profile prompt (STRM-461) only puts itself aside: no "keep off" choice to make.
    expect(PICTURE_NOTICE_COPY.profile.keep).toBe("Not now");
    expect(PICTURE_NOTICE_COPY.profile.act).toBe("Continue");
    for (const copy of Object.values(PICTURE_NOTICE_COPY)) {
      if (copy !== PICTURE_NOTICE_COPY.profile) expect(copy.keep).toBe("Keep off");
      // One short line: a notice heading a list, not the Settings explanation.
      expect(copy.body.split(/(?<=\.)\s+/).length).toBe(1);
      expect(copy.body.length).toBeLessThanOrEqual(110);
    }
  });
});
