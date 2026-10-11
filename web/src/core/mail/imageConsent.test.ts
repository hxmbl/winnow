/**
 * The remote-image consent rule: the decision that decides whether a sender
 * learns a message was opened. Written as rules about a boundary, since the
 * failure mode is a policy quietly not applying rather than a crash.
 */
import { describe, expect, it } from "vitest";
import { resolveImageConsent, type ImageConsent, type ImagePolicy } from "./imageConsent";

const MESSAGE = 1001;
const OTHER_MESSAGE = 2002;

const at = (policy: ImagePolicy, grantedFor: number | null, selectedId: number | null = MESSAGE) =>
  resolveImageConsent({ policy, grantedFor, selectedId });

describe("resolveImageConsent", () => {
  describe("the default: ask, and load nothing", () => {
    it("does not load remote images for a message nobody has answered for", () => {
      expect(at("ask", null)).toEqual({ imagesAllowed: false, askAboutImages: true });
    });

    it("offers the choice", () => {
      // The default must ask; loading or refusing silently would decide for the user.
      expect(at("ask", null).askAboutImages).toBe(true);
    });
  });

  describe("`always`", () => {
    it("loads remote images without asking", () => {
      expect(at("always", null)).toEqual({ imagesAllowed: true, askAboutImages: false });
    });

    it("stays permissive when a grant points at some other message", () => {
      // The standing answer ignores the grant, so a stale one cannot change it.
      expect(at("always", OTHER_MESSAGE).imagesAllowed).toBe(true);
    });
  });

  describe("`never`", () => {
    it("loads nothing and asks nothing", () => {
      expect(at("never", null)).toEqual({ imagesAllowed: false, askAboutImages: false });
    });

    it("ignores a grant made before the policy was set to never", () => {
      // The regression this module exists for: the grant used to survive a later
      // "never".
      expect(at("never", MESSAGE).imagesAllowed).toBe(false);
    });

    it("ignores a grant for a different message too", () => {
      expect(at("never", OTHER_MESSAGE).imagesAllowed).toBe(false);
    });

    it("does not ask, so there is no way back in from here", () => {
      // If `never` asked, the offer would re-open a decision already made.
      expect(at("never", null).askAboutImages).toBe(false);
    });
  });

  describe("a grant is for one message only", () => {
    it("allows the message it was made for", () => {
      expect(at("ask", MESSAGE).imagesAllowed).toBe(true);
    });

    it("does not carry to the next message", () => {
      // Consent that survives navigation is not consent, it is a standing
      // permission the user never gave.
      expect(at("ask", OTHER_MESSAGE).imagesAllowed).toBe(false);
    });

    it("does not carry when nothing is selected", () => {
      // An empty reader must not match a grant; the check compares ids, not a
      // bare "has a grant".
      expect(at("ask", MESSAGE, null).imagesAllowed).toBe(false);
    });

    it("still offers the choice on the next message", () => {
      // One-off permission, and the next message gets asked about again.
      expect(at("ask", OTHER_MESSAGE).askAboutImages).toBe(true);
    });
  });

  describe("the shape of the answer", () => {
    it("never reports ask as true while also allowing", () => {
      // Asking and permitting at once would render the offer over an already-loaded
      // message.
      for (const policy of ["ask", "always", "never"] as ImagePolicy[]) {
        for (const grantedFor of [null, MESSAGE, OTHER_MESSAGE]) {
          for (const selectedId of [null, MESSAGE, OTHER_MESSAGE]) {
            const { imagesAllowed, askAboutImages } = at(policy, grantedFor, selectedId);
            expect(imagesAllowed && askAboutImages).toBe(false);
          }
        }
      }
    });

    it("loads images only when something permitted it", () => {
      // Permission is never inferred; every true case has a reason the user gave.
      const cases: ImageConsent[] = [
        { policy: "always", grantedFor: null, selectedId: null },
        { policy: "always", grantedFor: null, selectedId: MESSAGE },
        { policy: "ask", grantedFor: MESSAGE, selectedId: MESSAGE },
      ];
      for (const c of cases) {
        expect(resolveImageConsent(c).imagesAllowed).toBe(true);
      }
    });
  });
});