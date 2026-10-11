/**
 * The asset planner.
 *
 * The property that matters is exhaustiveness. A message names its images in five
 * different places — `src`, `srcset`, `background`, `style="…url()"`, and a rule
 * inside a `<style>` block — and a proxy that rewrites four of them has produced a
 * document where one image still reaches the sender's CDN from the reader's
 * browser. That is a privacy claim which is true four times out of five, and
 * therefore not a privacy claim at all.
 *
 * So the tests run over a newsletter written to be as awkward as real mail rather
 * than as convenient as a fixture, and assert that nothing is left over.
 */

import { describe, expect, it } from "vitest";
import { planAssets, styleBlocks } from "./assets";
import { sanitizeMailHtml } from "../web/src/core/mail/sanitize";

/**
 * A newsletter of the shape real marketing mail has: a full document, a table
 * layout, a `cid:` logo, a hero, a `srcset`, a background image, a CSS sprite, an
 * imported font sheet, a tracking pixel, and an `onclick` a sender would like.
 */
const NEWSLETTER = `<!doctype html>
<html><head>
<style>
  @import url("https://fonts.example.test/brand.css");
  .logo { background-image: url('https://cdn.example.test/sprite.png'); }
  body { margin: 0 }
</style>
</head><body onclick="track()">
  <table width="600" cellpadding="0"><tr>
    <td background="https://cdn.example.test/tile.png">
      <img src="cid:logo@example.test" alt="Brand">
      <img src="https://cdn.example.test/hero.png" width="600" alt="Hero">
      <img srcset="https://cdn.example.test/hero.png 1x, https://cdn.example.test/hero@2x.png 2x"
           src="https://cdn.example.test/hero.png" alt="">
    </td>
  </tr></table>
  <img src="https://track.example.test/open.gif" width="1" height="1" alt="">
</body></html>`;

describe("planAssets", () => {
  const { assets } = planAssets(NEWSLETTER);
  const urls = assets.map((asset) => asset.url);

  it("finds every address the message names, in all five shapes", () => {
    expect(urls).toContain("https://cdn.example.test/hero.png");
    expect(urls).toContain("https://cdn.example.test/hero@2x.png"); // srcset
    expect(urls).toContain("https://cdn.example.test/tile.png"); // background
    expect(urls).toContain("https://cdn.example.test/sprite.png"); // url() in a rule
    expect(urls).toContain("https://fonts.example.test/brand.css"); // @import
    expect(urls).toContain("https://track.example.test/open.gif");
  });

  it("does not plan a cid:, which is bytes already inside the message", () => {
    // Fetching an inline part "on the reader's behalf" would mean fetching it from
    // the sender's own server for no reason, and counting it as remote.
    expect(urls.some((url) => url.startsWith("cid:"))).toBe(false);
  });

  it("does not plan a fragment or a data: URI", () => {
    const inline =
      '<img src="data:image/png;base64,iVBOR"><div style="fill:url(#g)"></div>';
    expect(planAssets(inline).assets).toHaveLength(0);
  });

  it("does not plan an anchor, which is not a request until somebody clicks it", () => {
    // Proxying this would mean fetching a landing page and serving it as if it were
    // an image; and the click is a deliberate act with its own consent.
    expect(planAssets('<a href="https://example.test/landing">click</a>').assets).toHaveLength(0);
  });

  it("names each address once, however many times the message repeats it", () => {
    // The hero appears in a `srcset` and a `src`. Two fetches of one image is the
    // cost of not deduplicating, and the count shown to the reader would then be
    // about occurrences rather than about things.
    expect(urls.filter((url) => url === "https://cdn.example.test/hero.png")).toHaveLength(1);
  });

  it("marks the ones the address policy refuses, and says why", () => {
    const hostile =
      '<img src="http://127.0.0.1/a.png"><img src="file:///etc/passwd">' +
      '<img src="https://user:pw@cdn.example.test/a.png"><img src="https://ok.test/a.png">';
    const planned = planAssets(hostile);

    expect(planned.byUrl.get("http://127.0.0.1/a.png")).toMatchObject({
      allowed: false,
      reason: "address",
    });
    expect(planned.byUrl.get("file:///etc/passwd")).toMatchObject({
      allowed: false,
      reason: "scheme",
    });
    expect(planned.byUrl.get("https://user:pw@cdn.example.test/a.png")).toMatchObject({
      allowed: false,
      reason: "credentials",
    });
    expect(planned.byUrl.get("https://ok.test/a.png")?.allowed).toBe(true);
  });

  it("reads a srcset descriptor as a descriptor and not as part of the address", () => {
    // `hero.png 2x` is not a URL, and treating it as one would plan a fetch for a
    // file that does not exist.
    expect(planAssets('<img srcset="https://cdn.example.test/a.png 2x">').assets).toHaveLength(1);
  });

  it("extracts the stylesheet blocks the planner also walks", () => {
    expect(styleBlocks(NEWSLETTER)).toHaveLength(1);
    expect(styleBlocks("<p>no styles here</p>")).toHaveLength(0);
  });
});

/**
 * The other half of the arrangement, and the reason the planner runs before
 * sanitising: the substitution happens *inside* the sanitiser, so a proxied
 * document never holds a remote address even briefly, and a stylesheet's `url()`
 * is covered by the same code path that covers a `src`.
 */
describe("the proxied document", () => {
  const planned = planAssets(NEWSLETTER);
  const resolved = new Map(
    planned.assets
      .filter((asset) => asset.allowed)
      .map((asset) => [asset.url, `/asset/${asset.url.replace(/[^a-z]/gi, "").slice(-8)}`]),
  );

  const proxied = sanitizeMailHtml(NEWSLETTER, {
    allowRemote: true,
    collectStyles: true,
    rewriteUrls: resolved,
  });

  it("leaves no remote address anywhere in the body", () => {
    expect(proxied.html).not.toMatch(/\ssrc="https?:/);
    expect(proxied.html).not.toMatch(/srcset="[^"]*https?:/);
    expect(proxied.html).not.toMatch(/background="[^"]*https?:/);
    expect(proxied.html).toContain("/asset/");
  });

  it("leaves no remote address inside the stylesheets either", () => {
    // The shape that a second rewrite pass forgets. `sanitizeCss` would have
    // turned it into `none`, which is not a leak — but substituting it is the
    // difference between a newsletter that renders as its sender wrote it and one
    // that renders as a list of words.
    expect(proxied.stylesheets.join("\n")).not.toContain("https://cdn.example.test");
    expect(proxied.stylesheets.join("\n")).toContain("/asset/");
  });

  it("keeps the descriptor on each srcset candidate", () => {
    expect(proxied.html).toMatch(/srcset="[^"]* 1x[^"]* 2x"/);
  });

  it("does not count a proxied address as withheld", () => {
    // It has been fetched, by somebody other than the reader. Reporting it as
    // blocked would be the same inflated-count lie `html.ts` records, in a new
    // place.
    expect(proxied.blockedRemote).toBe(0);
  });

  it("still drops what the sanitiser always drops", () => {
    expect(proxied.html).not.toContain("onclick");
    expect(proxied.html).not.toContain("<style");
  });

  it("still refuses an address the policy refused, and counts it", () => {
    // A document containing `src="http://127.0.0.1/a.png"` would be the proxy
    // quietly handing the reader's browser the one request it exists to make from
    // nowhere near the reader. It is withheld *and* counted, so the reader is told
    // rather than left with a silent gap.
    const hostile = sanitizeMailHtml('<img src="http://127.0.0.1/a.png">', {
      allowRemote: true,
      rewriteUrls: new Map(),
    });
    expect(hostile.html).not.toMatch(/\ssrc=/);
    expect(hostile.blockedRemote).toBe(1);
  });

  it("does not count a proxied address as withheld, and does not withhold an anchor", () => {
    // A link is not a fetch. It stays as the sender wrote it, uncounted, because
    // the reader's browser will not touch it until they click — and when they do,
    // that is a deliberate act rather than something the message could do silently.
    const linked = sanitizeMailHtml('<a href="https://cdn.example.test/landing">go</a>', {
      allowRemote: true,
      rewriteUrls: resolved,
    });
    expect(linked.html).toContain('href="https://cdn.example.test/landing"');
    expect(linked.blockedRemote).toBe(0);
  });
});