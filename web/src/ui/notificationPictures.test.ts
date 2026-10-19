import { describe, expect, it } from "vitest";
import type { LogoState } from "../core/avatars/logoCache";
import type { Email } from "../core/model/email";
import { NOTIFICATION_PICTURE_SIZE, notificationPictures } from "./notificationActions";
import { orderPictures, pictureWants, resolveSenderPicture, type LogoSource, type SenderPictures } from "./senderPictures";

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
