/**
 * Reading a message's HTML safely, and counting what it would have fetched.
 *
 * `html.ts` is where the reader's privacy posture lives, so its arithmetic is worth
 * testing directly. The second half of this file is about `countRemoteReferences`,
 * and the reason it needs its own file is that the number it produces is a *claim to
 * the user* rather than a formatting detail: "3 remote references were blocked" says
 * what Winnow declined to fetch on their behalf.
 *
 * A false reassurance is worse than silence there. A message whose count includes its
 * own inline logo and its background colours tells somebody who has decided to trust
 * this client with their inbox that nothing was blocked — and that is exactly the
 * moment they stop checking.
 */

import { describe, expect, it } from "vitest";
import { countRemoteReferences, remoteReferences } from "./html";

describe("countRemoteReferences", () => {
  it("counts a plain remote image", () => {
    expect(countRemoteReferences('<img src="https://tracker.example/p.gif">')).toBe(1);
  });

  it("counts every remote image", () => {
    expect(
      countRemoteReferences(
        '<img src="https://a.example/1.png"><img src="https://b.example/2.png">',
      ),
    ).toBe(2);
  });

  it("does not count an inline data: image", () => {
    // Bytes already in the message. Counting it told the user something was blocked
    // when nothing left their machine.
    expect(countRemoteReferences('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(0);
  });

  it("does not count a background colour", () => {
    // The single most common false positive in mail HTML. `background` is an attribute
    // that carries both a colour and a URL, and only one of those is a request.
    expect(countRemoteReferences('<td background="#ffffff">')).toBe(0);
    expect(countRemoteReferences('<td background="red">')).toBe(0);
    expect(countRemoteReferences('<body style="background: #ffffff">')).toBe(0);
  });

  it("does count a background image", () => {
    // …and the other half of that distinction.
    expect(countRemoteReferences('<td background="https://a.example/bg.png">')).toBe(1);
  });

  it("counts a remote url() in a stylesheet", () => {
    expect(
      countRemoteReferences('<div style="background-image: url(https://a.example/p.gif)">'),
    ).toBe(1);
  });

  it("does not count a data: or fragment url()", () => {
    expect(
      countRemoteReferences('<div style="background-image: url(data:image/gif;base64,R0lGOD)">'),
    ).toBe(0);
    expect(countRemoteReferences('<div style="background-image: url(#gradient)">')).toBe(0);
  });

  it("handles single-quoted and unquoted attributes", () => {
    expect(countRemoteReferences("<img src='https://a.example/1.png'>")).toBe(1);
    expect(countRemoteReferences("<img src=https://a.example/1.png>")).toBe(1);
  });

  it("is not confused by a srcset with several candidates", () => {
    // One request set, and the number the user reads should not be three times the
    // thing they would see load.
    expect(remoteReferences('<img srcset="https://a.example/1x.png 1x">')).toEqual([
      "https://a.example/1x.png 1x",
    ]);
  });

  it("reports zero for a body with nothing to fetch", () => {
    expect(countRemoteReferences("<p>Hello. <b>No images.</b></p>")).toBe(0);
    expect(countRemoteReferences("")).toBe(0);
  });

  it("does not count the strings a message merely mentions", () => {
    // A plain-text message quoting an HTML snippet is text, and a mail client that
    // counted `<img src=…>` inside a code sample would announce a tracking pixel that
    // was never going to load.
    expect(
      countRemoteReferences('<pre>&lt;img src="https://x.example/p.gif"&gt;</pre>'),
    ).toBe(0);
  });

  /**
   * The regression this exists for, stated as one number.
   *
   * A newsletter with an inline logo and a tinted table used to report three blocked
   * references while fetching nothing.
   */
  it("does not inflate the note for a decorative newsletter body", () => {
    const newsletter =
      '<table><tr><td background="#f5f5f5">' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />' +
      "</td></tr></table>";
    expect(countRemoteReferences(newsletter)).toBe(0);
  });

  /**
   * And it must not under-report either.
   *
   * The same care in the other direction: a single tracking pixel is the case the
   * note exists for, and a counter that misses it is the bug the feature was added to
   * fix.
   */
  it("does not miss a lone tracking pixel", () => {
    expect(countRemoteReferences('<img width="1" height="1" src="https://x.example/p.gif">')).toBe(
      1,
    );
    expect(countRemoteReferences('<img src=x.src="/open?u=1" width="1">')).toBe(1);
  });

  it("counts a campaign with both styles of pixel", () => {
    const body =
      '<img src="https://x.example/a.gif">' +
      '<img src="https://x.example/b.gif">' +
      '<table background="https://x.example/c.gif"><tr><td background="#fff">x</td></tr></table>';
    expect(remoteReferences(body)).toEqual([
      "https://x.example/a.gif",
      "https://x.example/b.gif",
      "https://x.example/c.gif",
    ]);
  });
});
/**
 * A `<style>` block is the other half of the counter, and it was missing.
 *
 * The cases above pin the false positives — `data:` URIs, `background="#fff"`, a
 * newsletter quoting an `<img>` snippet — and the direction that matters most for
 * a privacy claim is the opposite one. A counter that under-reports says "nothing
 * was blocked", and somebody who reads that stops checking. Modern mail keeps its
 * layout in a `<style>` block and its font imports, sprite sheets and tracking
 * scripts with it, so a counter that only read attributes reported zero for
 * precisely the messages that fetch the most.
 */
describe("remote references inside a <style> block", () => {
  it("counts a font import", () => {
    expect(countRemoteReferences("<style>@import url('https://x.example/f.css');</style>")).toBe(1);
  });

  it("counts the bare @import spelling, which has no url() around it", () => {
    expect(countRemoteReferences("<style>@import 'https://x.example/f.css';</style>")).toBe(1);
    expect(countRemoteReferences('<style>@import "https://x.example/f.css";</style>')).toBe(1);
  });

  it("counts an import once, not once per spelling of it", () => {
    // `@import url(x)` matches both the import pattern and the `url()` pattern, so
    // a naive double scan reports 2 for one font. A counter that double-counts is
    // the same class of lie as one that under-counts.
    expect(countRemoteReferences("<style>@import url(https://x.example/f.css);</style>")).toBe(1);
  });

  it("counts every url() a rule paints", () => {
    expect(
      countRemoteReferences(
        "<style>.a{background:url(https://x.example/a.png)}.b{background:url(https://x.example/b.png)}</style>",
      ),
    ).toBe(2);
  });

  it("counts an import that sits inside a full document's head", () => {
    const html =
      "<html><head><style>@import url(https://x.example/f.css);</style></head><body><p>x</p></body></html>";
    expect(countRemoteReferences(html)).toBe(1);
  });

  it("does not count a local url() or a data: one", () => {
    expect(countRemoteReferences("<style>a{fill:url(#gradient)}</style>")).toBe(0);
    expect(countRemoteReferences("<style>a{background:url(data:image/png;base64,iVBOR)}</style>")).toBe(0);
  });

  it("does not count the word url() inside a quoted snippet in the body text", () => {
    // The escaped-HTML case the attribute scan already guards, on the other side
    // of it: a newsletter explaining its own unsubscribe link quotes a stylesheet.
    const html = "<pre>&lt;style&gt;a{background:url(https://x.example/a.png)}&lt;/style&gt;</pre>";
    expect(countRemoteReferences(html)).toBe(0);
  });
});
