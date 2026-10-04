/**
 * The remote-image consent rule.
 *
 * This is the decision that decides whether a sender learns that a message was
 * opened: a tracking pixel firing is an answer to that question, given away for
 * free. It was two expressions in `App.tsx` with no test at all, which is how it
 * came to have a hole in it — the per-message grant was an `||` against the
 * standing policy, so nothing could veto it and "never" did not mean never.
 *
 * These are written as rules about a boundary rather than as tests of a branch,
 * because the failure mode is not a crash. It is a policy quietly not applying,
 * which no assertion about a return value will notice unless the rule itself is
 * written down.
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
      // The default has to *ask*; a default that silently loaded, or silently
      // refused, would each be a privacy decision made without the user.
      expect(at("ask", null).askAboutImages).toBe(true);
    });
  });

  describe("`always`", () => {
    it("loads remote images without asking", () => {
      expect(at("always", null)).toEqual({ imagesAllowed: true, askAboutImages: false });
    });

    it("stays permissive when a grant points at some other message", () => {
      // The standing answer does not depend on the grant at all, so a stale grant
      // from another message cannot change it.
      expect(at("always", OTHER_MESSAGE).imagesAllowed).toBe(true);
    });
  });

  describe("`never`", () => {
    it("loads nothing and asks nothing", () => {
      expect(at("never", null)).toEqual({ imagesAllowed: false, askAboutImages: false });
    });

    it("ignores a grant made before the policy was set to never", () => {
      // The regression this module exists for. The user allowed images for one
      // message, then went and answered "never"; the grant used to survive that,
      // because the expression was `always || granted`, and no clause could veto
      // it. The tracking pixel kept firing for that message until they navigated
      // away and back and the grant happened to clear.
      expect(at("never", MESSAGE).imagesAllowed).toBe(false);
    });

    it("ignores a grant for a different message too", () => {
      expect(at("never", OTHER_MESSAGE).imagesAllowed).toBe(false);
    });

    it("does not ask, so there is no way back in from here", () => {
      // If `never` asked, the offer would be the way to re-open a decision the
      // user has already made.
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
      // An empty reader must not match a grant: `grantedFor !== null` on its own
      // would be enough to make this true, which is why the comparison is to the
      // selected id rather than to a bare "has a grant".
      expect(at("ask", MESSAGE, null).imagesAllowed).toBe(false);
    });

    it("still offers the choice on the next message", () => {
      // One-off permission, and the next message gets asked about again.
      expect(at("ask", OTHER_MESSAGE).askAboutImages).toBe(true);
    });
  });

  describe("the shape of the answer", () => {
    it("never reports ask as true while also allowing", () => {
      // Asking a question and permitting the thing being asked about cannot both
      // be true; the reader renders the offer above the message and the sandboxed
      // frame below it, so a state with both would show the message loaded while
      // asking whether to load it.
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
      // The invariant stated directly: permission is never inferred. Every case
      // that returns true has a reason the user gave.
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