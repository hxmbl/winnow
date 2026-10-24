import { describe, expect, it } from "vitest";
import {
  gatedPictureBytes,
  isRelayedName,
  orderPictureCandidates,
  orderPictures,
  pictureTries,
  senderPictureSources,
  staticLogoSource,
  type PictureBytesSource,
} from "./senderPictures";
import { pictureKey, type PictureKind } from "../core/avatars/pictureBytes";

describe("relayed senders get no brand logo", () => {
  it("spots a list or group relay", () => {
    expect(isRelayedName("Ana via Book Club")).toBe(true);
    expect(isRelayedName("Ana Lima via Google Docs")).toBe(true);
    expect(isRelayedName("ana VIA lists")).toBe(true);
  });

  it("leaves a brand called VIA, and names that only contain the letters, alone", () => {
    expect(isRelayedName("VIA Rail Canada")).toBe(false);
    expect(isRelayedName("Viacom")).toBe(false);
    expect(isRelayedName("Olivia")).toBe(false);
    expect(isRelayedName("Trivia Night")).toBe(false);
  });

  it("is false with no name", () => {
    expect(isRelayedName(undefined)).toBe(false);
    expect(isRelayedName("")).toBe(false);
  });
});

describe("picture order", () => {
  const photo = "https://lh3.googleusercontent.com/a/photo=s96-c";
  const base = `https://gravatar.com/avatar/${"a".repeat(64)}`;
  const logo = { kind: "logo", url: "https://brand.example/logo.svg" } as const;
  const gravatar = { kind: "logo", url: base } as const;
  const none = { kind: "none" } as const;
  const unknown = { kind: "unknown" } as const;

  it("puts the contact photo first, then Gravatar, then the brand logo", () => {
    expect(orderPictures(photo, gravatar, logo, 32)).toEqual([photo, `${base}?d=404&s=64`, logo.url]);
    expect(orderPictures(undefined, gravatar, logo, 32)).toEqual([`${base}?d=404&s=64`, logo.url]);
  });

  it("sizes Gravatar at twice the avatar", () => {
    expect(orderPictures(undefined, gravatar, none, 36)).toEqual([`${base}?d=404&s=72`]);
  });

  it("falls to the logo when there is no Gravatar, and holds the monogram while Gravatar is unknown", () => {
    expect(orderPictures(undefined, none, logo, 32)).toEqual([logo.url]);
    expect(orderPictures(undefined, unknown, logo, 32)).toEqual([]);
  });

  it("is the monogram when nothing is known", () => {
    expect(orderPictures(undefined, none, none, 32)).toEqual([]);
  });
});

describe("kept picture copies", () => {
  const PHOTO = "https://lh3.googleusercontent.com/a/photo=s96-c";
  const GRAV = `https://gravatar.com/avatar/${"b".repeat(64)}`;
  const LOGO = "https://brand.example/logo.svg";
  const COPY = "data:image/webp;base64,UklGRg==";

  /** A bytes cache over a fixed table, recording what it was asked to do. */
  function fakeBytes(table: Record<string, PictureKind>) {
    const remembered: string[] = [];
    const touched: string[] = [];
    const bytes: PictureBytesSource = {
      get: (url) => {
        const key = pictureKey(url);
        const kind = key ? table[key] : undefined;
        return kind && key ? { key, kind, data: COPY, savedAt: 0, usedAt: 0 } : null;
      },
      isStale: () => true,
      touch: (url) => touched.push(url),
      remember: async (url) => {
        remembered.push(url);
        return true;
      },
      subscribe: () => () => undefined,
      getVersion: () => 0,
    };
    return { bytes, remembered, touched };
  }

  it("orders candidates with their source", () => {
    expect(orderPictureCandidates(PHOTO, { kind: "logo", url: GRAV }, { kind: "logo", url: LOGO }, 32)).toEqual([
      { url: PHOTO, kind: "contact" },
      { url: `${GRAV}?d=404&s=64`, kind: "gravatar" },
      { url: LOGO, kind: "logo" },
    ]);
  });

  it("tries a picture's kept copy first, then its URL", () => {
    const { bytes } = fakeBytes({ [GRAV]: "gravatar" });
    const tries = pictureTries(
      [
        { url: `${GRAV}?d=404&s=64`, kind: "gravatar" },
        { url: LOGO, kind: "logo" },
      ],
      bytes,
    );
    expect(tries.map((t) => [t.src, t.cached])).toEqual([
      [COPY, true],
      [`${GRAV}?d=404&s=64`, false],
      [LOGO, false],
    ]);
    expect(pictureTries([{ url: LOGO, kind: "logo" }], null).map((t) => t.src)).toEqual([LOGO]);
  });

  it("never serves or keeps a Gravatar or logo copy while its switch is off or Remote images is Never", async () => {
    const { bytes, remembered } = fakeBytes({ [PHOTO]: "contact", [GRAV]: "gravatar", [LOGO]: "logo" });
    const on = staticLogoSource({});
    const never = senderPictureSources({ photos: new Map(), gravatars: on, logos: on, imagePolicy: "never", bytes });
    expect(never.bytes?.get(PHOTO)).not.toBeNull();
    expect(never.bytes?.get(GRAV)).toBeNull();
    expect(never.bytes?.get(LOGO)).toBeNull();
    expect(await never.bytes?.remember(LOGO, "logo")).toBe(false);
    expect(await never.bytes?.remember(GRAV, "gravatar")).toBe(false);

    const logosOff = senderPictureSources({ photos: new Map(), gravatars: on, logos: null, imagePolicy: "ask", bytes });
    expect(logosOff.bytes?.get(GRAV)).not.toBeNull();
    expect(logosOff.bytes?.get(LOGO)).toBeNull();
    expect(await logosOff.bytes?.remember(LOGO, "logo")).toBe(false);
    expect(await logosOff.bytes?.remember(GRAV, "gravatar")).toBe(true);
    expect(remembered).toEqual([GRAV]);

    expect(senderPictureSources({ photos: new Map(), gravatars: on, logos: on, imagePolicy: "always" }).bytes).toBeNull();
  });

  it("a gated touch only reaches a copy that may be drawn", () => {
    const { bytes, touched } = fakeBytes({ [GRAV]: "gravatar", [PHOTO]: "contact" });
    const gated = gatedPictureBytes(bytes, { contact: true, gravatar: false, logo: false });
    gated.touch(GRAV);
    gated.touch(PHOTO);
    expect(touched).toEqual([PHOTO]);
  });
});
