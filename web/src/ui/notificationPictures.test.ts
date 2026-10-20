import { describe, expect, it } from "vitest";
import type { LogoState } from "../core/avatars/logoCache";
import type { Email } from "../core/model/email";
import {
  NATIVE_PICTURE_MAX_CHARS,
  NATIVE_PICTURE_PIXELS,
  NOTIFICATION_PICTURE_SIZE,
  announce,
  canvasRasterise,
  drawPicture,
  isBlankPixels,
  isNativePicture,
  nativePictures,
  notificationPictures,
  pictureDrawRect,
  type PictureContext,
} from "./notificationActions";
import type { WinnowStore } from "../core/store/store";
import type { Platform } from "../platform/types";
import { orderPictures, pictureWants, publishSenderPictures, remotePicturesPaused, resolveSenderPicture, senderPictureSources, type LogoSource, type SenderPictures } from "./senderPictures";
import { readFileSync } from "node:fs";
import { afterEach, vi } from "vitest";

/** A source that answers `table` after a request, and records every address asked. */
function source(table: Record<string, string | null>, { slow = false } = {}): LogoSource & { asked: string[] } {
  const known = new Map<string, string | null>();
  const asked: string[] = [];
  return {
    asked,
    peek(address): LogoState {
      if (!known.has(address)) return { kind: "unknown" };
      const url = known.get(address);
      return url ? { kind: "logo", url } : { kind: "none" };
    },
    request(address) {
      asked.push(address);
      if (slow) return new Promise(() => undefined);
      known.set(address, table[address] ?? null);
      return Promise.resolve(table[address] ?? null);
    },
    subscribe: () => () => undefined,
    getVersion: () => 0,
  };
}

const ADA = "ada@example.com";
const GRAVATAR = "https://gravatar.com/avatar/abc";
const LOGO = "https://example.com/logo.svg";
const PHOTO = "https://lh3.googleusercontent.com/a/ada";

function sources(over: Partial<SenderPictures> = {}): SenderPictures {
  return { photos: new Map(), gravatars: null, logos: null, ...over };
}

function mail(overrides: Partial<Email> = {}): Email {
  return { id: 1, gmailId: "g1", sender: ADA, name: "Ada", mailbox: "inbox", unread: true, receivedAt: 1, subject: "Hi", body: "", ...overrides } as Email;
}

describe("a notification's sender picture follows the avatar's settings", () => {
  it("with Gravatar and brand logos both off and no contact photo: nothing, and no lookup", async () => {
    const g = source({ [ADA]: GRAVATAR });
    const l = source({ [ADA]: LOGO });
    // Off is `null` in the sources, exactly as App builds them for the avatars.
    expect(await resolveSenderPicture(sources(), ADA, "Ada", 96)).toBeNull();
    expect(g.asked).toEqual([]);
    expect(l.asked).toEqual([]);
  });

  it("prefers the contact photo, and then asks nothing else", async () => {
    const g = source({ [ADA]: GRAVATAR });
    const l = source({ [ADA]: LOGO });
    const s = sources({ photos: new Map([[ADA, PHOTO]]), gravatars: g, logos: l });
    expect(await resolveSenderPicture(s, "Ada@Example.com".toLowerCase(), "Ada", 96)).toBe(PHOTO);
    expect(g.asked).toEqual([]);
    expect(l.asked).toEqual([]);
  });

  it("uses Gravatar when it is on, sized like an avatar (twice the size)", async () => {
    const s = sources({ gravatars: source({ [ADA]: GRAVATAR }) });
    expect(await resolveSenderPicture(s, ADA, "Ada", 96)).toBe(`${GRAVATAR}?d=404&s=192`);
  });

  it("falls back to the brand logo only once Gravatar has said none, and only when logos are on", async () => {
    const g = source({});
    const l = source({ [ADA]: LOGO });
    expect(await resolveSenderPicture(sources({ gravatars: g, logos: l }), ADA, "Ada", 96)).toBe(LOGO);
    expect(await resolveSenderPicture(sources({ gravatars: source({}) }), ADA, "Ada", 96)).toBeNull();
    expect(await resolveSenderPicture(sources({ logos: source({ [ADA]: LOGO }) }), ADA, "Ada", 96)).toBe(LOGO);
  });

  it("gives a relayed sender ('Ana via Book Club') no Gravatar or logo, like the avatar", async () => {
    const l = source({ [ADA]: LOGO });
    expect(await resolveSenderPicture(sources({ logos: l }), ADA, "Ana via Book Club", 96)).toBeNull();
    expect(l.asked).toEqual([]);
  });

  it("does not wait forever: a Gravatar still unknown after the wait means no logo either (the avatar's rule)", async () => {
    const s = sources({ gravatars: source({}, { slow: true }), logos: source({ [ADA]: LOGO }) });
    expect(await resolveSenderPicture(s, ADA, "Ada", 96, 10)).toBeNull();
  });

  it("is the avatar's own decision: same wants, same order", async () => {
    const g = source({});
    const l = source({ [ADA]: LOGO });
    const s = sources({ gravatars: g, logos: l });
    expect(pictureWants(s, ADA, undefined, "Ada")).toEqual({ contactPhoto: undefined, wantGravatar: true, wantLogo: true });
    const resolved = await resolveSenderPicture(s, ADA, "Ada", 32);
    expect(resolved).toBe(orderPictures(undefined, g.peek(ADA), l.peek(ADA), 32)[0]);
  });
});

describe("the pictures a batch of notifications carries", () => {
  it("resolves one per shown message, by Gmail id, at the notification size", async () => {
    const s = sources({ gravatars: source({ [ADA]: GRAVATAR }) });
    const out = await notificationPictures([mail(), mail({ id: 2, gmailId: "g2", sender: "bob@example.com", name: "Bob" })], false, s);
    expect(out).toEqual({ g1: `${GRAVATAR}?d=404&s=${NOTIFICATION_PICTURE_SIZE * 2}` });
  });

  it("looks nothing up while lock-screen previews are hidden", async () => {
    const g = source({ [ADA]: GRAVATAR });
    expect(await notificationPictures([mail()], true, sources({ gravatars: g }))).toEqual({});
    expect(g.asked).toEqual([]);
  });

  it("before the app has published its sources (nothing mounted): no pictures", async () => {
    expect(await notificationPictures([mail()], false)).toEqual({});
  });
});

describe("Remote images = Never pauses remote avatar lookups (1.3.3)", () => {
  const build = (imagePolicy: "ask" | "always" | "never", photos = new Map<string, string>()) => {
    const g = source({ [ADA]: GRAVATAR });
    const l = source({ [ADA]: LOGO });
    return { g, l, s: senderPictureSources({ photos, gravatars: g, logos: l, imagePolicy }) };
  };

  it("with both switches on, Never drops Gravatar and brand logos from the shared sources", () => {
    const { s } = build("never");
    expect(s.gravatars).toBeNull();
    expect(s.logos).toBeNull();
    expect(remotePicturesPaused("never")).toBe(true);
    expect(remotePicturesPaused("ask")).toBe(false);
  });

  it("Ask and Always keep them, exactly as the switches say", () => {
    for (const policy of ["ask", "always"] as const) {
      const { s, g, l } = build(policy);
      expect(s.gravatars).toBe(g);
      expect(s.logos).toBe(l);
    }
  });

  it("the avatar under Never: no lookup at all, monogram (no picture)", () => {
    const { s, g, l } = build("never");
    const wants = pictureWants(s, ADA, undefined, "Ada");
    expect(wants).toEqual({ contactPhoto: undefined, wantGravatar: false, wantLogo: false });
    expect(g.asked).toEqual([]);
    expect(l.asked).toEqual([]);
  });

  it("a notification under Never: no Gravatar or logo request, no picture", async () => {
    const { s, g, l } = build("never");
    expect(await notificationPictures([mail()], false, s)).toEqual({});
    expect(g.asked).toEqual([]);
    expect(l.asked).toEqual([]);
  });

  it("a local contact photo still shows under Never, in the app and in a notification", async () => {
    const { s, g } = build("never", new Map([[ADA, PHOTO]]));
    expect(pictureWants(s, ADA).contactPhoto).toBe(PHOTO);
    expect(await notificationPictures([mail()], false, s)).toEqual({ g1: PHOTO });
    expect(g.asked).toEqual([]);
  });

  it("hidden lock-screen previews still suppress everything, whatever the policy", async () => {
    const { s, g, l } = build("always", new Map([[ADA, PHOTO]]));
    expect(await notificationPictures([mail()], true, s)).toEqual({});
    expect(g.asked).toEqual([]);
    expect(l.asked).toEqual([]);
  });

  it("App builds the avatar sources through the shared resolver with the image policy", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/senderPictureSources\(\{[\s\S]*imagePolicy,[\s\S]*\}\)/);
  });
});

describe("native notifications get the picture as bytes, never a URL (1.3.3)", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("accepts only a small base64 PNG or JPEG data URL", () => {
    expect(isNativePicture(PNG)).toBe(true);
    expect(isNativePicture("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isNativePicture(GRAVATAR)).toBe(false);
    expect(isNativePicture("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isNativePicture("data:image/png;base64,abc<script>")).toBe(false);
    expect(isNativePicture(`data:image/png;base64,${"A".repeat(NATIVE_PICTURE_MAX_CHARS)}`)).toBe(false);
    expect(isNativePicture(null)).toBe(false);
  });

  it("rasterises each resolved URL at twice the notification size (sharp on a 3x phone), and drops one that fails", async () => {
    const asked: [string, number][] = [];
    const rasterise = async (url: string, size: number) => {
      asked.push([url, size]);
      if (url === LOGO) throw new Error("tainted");
      return url === GRAVATAR ? PNG : null;
    };
    const out = await nativePictures({ g1: GRAVATAR, g2: LOGO, g3: PHOTO, g4: PNG }, rasterise);
    expect(out).toEqual({ g1: PNG, g4: PNG });
    expect(asked).toEqual([
      [GRAVATAR, NATIVE_PICTURE_PIXELS],
      [LOGO, NATIVE_PICTURE_PIXELS],
      [PHOTO, NATIVE_PICTURE_PIXELS],
    ]);
  });

  it("a rasteriser that answers something that is not a PNG/JPEG data URL is ignored", async () => {
    expect(await nativePictures({ g1: GRAVATAR }, async () => GRAVATAR)).toEqual({});
  });

  it("announce hands the desktop/Android platform no URL, and the web platform the URL", async () => {
    publishSenderPictures(sources({ photos: new Map([[ADA, PHOTO]]) }));
    try {
      const sent: { kind: string; pictures: (string | null)[] }[] = [];
      for (const kind of ["desktop", "web"] as const) {
        const store = {
          getSnapshot: () => ({ preferences: { notificationHidePreview: false, notificationActions: { reply: true, read: true, trash: true } } }),
          notificationReplyHeads: async () => ({}),
        } as unknown as WinnowStore;
        const platform = {
          info: async () => ({ kind, os: kind === "web" ? "web" : "linux" }),
          notifyNewMail: async (batch: { messages: { picture: string | null }[] }) => {
            sent.push({ kind, pictures: batch.messages.map((m) => m.picture) });
          },
        } as unknown as Platform;
        await announce(store, platform, [mail()]);
      }
      // No canvas in the test environment: the desktop's rasterising fails, so it gets none.
      expect(sent).toEqual([
        { kind: "desktop", pictures: [null] },
        { kind: "web", pictures: [PHOTO] },
      ]);
    } finally {
      publishSenderPictures(sources());
    }
  });
});

describe("drawing a sender picture for a native notification (1.4.0)", () => {
  /** A 2D context that records what was drawn; `blank` says whether the draw left any pixel. */
  function fakeContext({ blank = false } = {}) {
    const calls: unknown[][] = [];
    const context: PictureContext = {
      drawImage: (...args: unknown[]) => void calls.push(["drawImage", ...args.slice(1)]),
      getImageData: (_x, _y, w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        if (!blank) data[3 + 4 * 5] = 255;
        return { data };
      },
      fillRect: (...args: number[]) => void calls.push(["fillRect", ...args, context.fillStyle, context.globalCompositeOperation]),
      fillStyle: "",
      globalCompositeOperation: "source-over",
    };
    return { context, calls };
  }

  it("covers the square and centres it, in destination space, like the avatar's object-cover", () => {
    expect(pictureDrawRect(100, 100, 192)).toEqual({ x: 0, y: 0, width: 192, height: 192 });
    // Wide: full height, the sides overflow equally.
    expect(pictureDrawRect(200, 100, 100)).toEqual({ x: -50, y: 0, width: 200, height: 100 });
    // Tall: full width, top and bottom overflow equally.
    expect(pictureDrawRect(50, 100, 100)).toEqual({ x: 0, y: -50, width: 100, height: 200 });
  });

  it("an SVG logo with only a viewBox (no natural size reported) fills the square rather than a corner", () => {
    // Some engines report 0x0 for `<svg viewBox="0 0 256 256">` with no width/height.
    expect(pictureDrawRect(0, 0, 192)).toEqual({ x: 0, y: 0, width: 192, height: 192 });
    // Chromium reports 150x150 for the same SVG: still drawn at the full square.
    expect(pictureDrawRect(150, 150, 192)).toEqual({ x: 0, y: 0, width: 192, height: 192 });
  });

  it("draws with the destination-only drawImage form (never a source crop by the reported size)", () => {
    const { context, calls } = fakeContext();
    expect(drawPicture(context, {} as CanvasImageSource, { width: 150, height: 150 }, 192, null)).toBe(true);
    expect(calls).toEqual([["drawImage", 0, 0, 192, 192]]);
  });

  it("puts the avatar's backdrop behind the picture, so a transparent logo is opaque and round-friendly", () => {
    const { context, calls } = fakeContext();
    drawPicture(context, {} as CanvasImageSource, { width: 64, height: 64 }, 192, "#e8e8e8");
    expect(calls).toEqual([
      ["drawImage", 0, 0, 192, 192],
      ["fillRect", 0, 0, 192, 192, "#e8e8e8", "destination-over"],
    ]);
    expect(context.globalCompositeOperation).toBe("source-over");
  });

  it("a picture that drew nothing at all is no picture (the app icon, not an empty disc)", () => {
    const { context, calls } = fakeContext({ blank: true });
    expect(drawPicture(context, {} as CanvasImageSource, { width: 0, height: 0 }, 192, "#e8e8e8")).toBe(false);
    expect(calls.some((call) => call[0] === "fillRect")).toBe(false);
    expect(isBlankPixels(new Uint8ClampedArray([1, 2, 3, 0, 9, 9, 9, 0]))).toBe(true);
    expect(isBlankPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(false);
  });

  describe("the webview rasteriser", () => {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const JPEG = "data:image/jpeg;base64,/9j/4AAQ";
    let images: FakeImage[] = [];
    class FakeImage {
      crossOrigin: string | null = null;
      referrerPolicy = "";
      decoding = "";
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        images.push(this);
      }
    }
    function stub({ blank = false, png = PNG, background = "" } = {}) {
      images = [];
      const { context, calls } = fakeContext({ blank });
      const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: (type: string) => (type === "image/png" ? png : JPEG) };
      vi.stubGlobal("Image", FakeImage);
      vi.stubGlobal("document", { createElement: () => canvas, documentElement: {} });
      vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => background }));
      return { calls, canvas };
    }
    afterEach(() => vi.unstubAllGlobals());

    it("loads anonymously with no referrer, and draws an SVG logo over the avatar backdrop", async () => {
      const { calls, canvas } = stub({ background: " #373737 " });
      const pending = canvasRasterise(1000)("https://www.redditstatic.com/bimi/redditbimi.svg", 192);
      const img = images[0];
      expect(img.crossOrigin).toBe("anonymous");
      expect(img.referrerPolicy).toBe("no-referrer");
      img.naturalWidth = 150;
      img.naturalHeight = 150;
      img.onload?.();
      expect(await pending).toBe(PNG);
      expect(canvas.width).toBe(192);
      expect(calls).toEqual([
        ["drawImage", 0, 0, 192, 192],
        ["fillRect", 0, 0, 192, 192, "#373737", "destination-over"],
      ]);
    });

    it("a host without CORS (the load fails) or a picture that draws nothing: null", async () => {
      stub();
      const failing = canvasRasterise(1000)("https://example.com/logo.svg", 192);
      images[0].onerror?.();
      expect(await failing).toBeNull();
      stub({ blank: true });
      const empty = canvasRasterise(1000)("https://example.com/logo.svg", 192);
      images[0].onload?.();
      expect(await empty).toBeNull();
    });

    it("a PNG over the cap goes as a JPEG rather than not at all", async () => {
      stub({ png: `data:image/png;base64,${"A".repeat(NATIVE_PICTURE_MAX_CHARS)}` });
      const pending = canvasRasterise(1000)("https://gravatar.com/avatar/abc?s=192", 192);
      images[0].onload?.();
      expect(await pending).toBe(JPEG);
    });
  });
});
