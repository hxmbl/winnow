/**
 * Reading a message's HTML safely, and counting what it would have fetched.
 *
 * The counter's number is a claim to the user, so its precision matters: a false
 * reassurance that nothing was blocked is worse than silence.
 */

import { describe, expect, it } from "vitest";
import {
  countRemoteReferences,
  parseAddressHeader,
  parseAddressList,
  remoteReferences,
  plainTextFromHtml,
  sanitizeDisplayName,
  tidyPlainText,
} from "./html";

describe("parseAddressHeader", () => {
  it("reads a display name and an address", () => {
    expect(parseAddressHeader("Ada Lovelace <ada@example.com>")).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.com",
    });
  });

  it("reads a quoted display name, including a quote inside it", () => {
    expect(parseAddressHeader('"Ada, Countess" <ada@example.com>')).toEqual({
      name: "Ada, Countess",
      address: "ada@example.com",
    });
    expect(parseAddressHeader('"Ada \\"Countess\\"" <ada@example.com>')).toEqual({
      name: 'Ada "Countess"',
      address: "ada@example.com",
    });
  });

  it("has no name for a bare address", () => {
    expect(parseAddressHeader("ada@example.com")).toEqual({ address: "ada@example.com" });
  });

  it("refuses anything that is not an address", () => {
    expect(parseAddressHeader("Ada Lovelace")).toBeNull();
    expect(parseAddressHeader("")).toBeNull();
    expect(parseAddressHeader("ada@localhost")).toBeNull();
  });
});

describe("parseAddressList", () => {
  it("reads one address", () => {
    expect(parseAddressList("Ada Lovelace <ada@example.com>")).toEqual([
      { name: "Ada Lovelace", address: "ada@example.com" },
    ]);
  });

  it("reads a list, with and without names", () => {
    expect(parseAddressList("ada@example.com, Grace <grace@example.com>")).toEqual([
      { address: "ada@example.com" },
      { name: "Grace", address: "grace@example.com" },
    ]);
  });

  it("does not split on a comma inside a quoted name", () => {
    // The reason this is a scanner and not `split(",")`. Two fragments come out of the
    // naive version, neither of which parses, and the recipient list loses a person.
    expect(parseAddressList('"Ng, Alex" <alex@example.com>, ada@example.com')).toEqual([
      { name: "Ng, Alex", address: "alex@example.com" },
      { address: "ada@example.com" },
    ]);
  });

  it("does not split on a comma inside a comment, and drops the comment", () => {
    expect(parseAddressList("ada@example.com (Ada, Countess), grace@example.com")).toEqual([
      { address: "ada@example.com" },
      { address: "grace@example.com" },
    ]);
  });

  it("does not split inside angle brackets", () => {
    expect(parseAddressList("<ada@example.com>")).toEqual([{ address: "ada@example.com" }]);
  });

  it("does not close a comment on an escaped bracket", () => {
    // `\)` inside the comment is a literal paren, so the next address still parses.
    expect(parseAddressList("ada@example.com (see \\) below), grace@example.com")).toEqual([
      { address: "ada@example.com" },
      { address: "grace@example.com" },
    ]);
  });

  it("unwraps a group, naming it where the address has no name of its own", () => {
    expect(
      parseAddressList("Platform team: ada@example.com, <grace@example.com>;"),
    ).toEqual([
      { name: "Platform team", address: "ada@example.com" },
      { address: "grace@example.com" },
    ]);
  });

  it("keeps an address's own name over the group's", () => {
    expect(parseAddressList("Platform team: Ada <ada@example.com>;")).toEqual([
      { name: "Ada", address: "ada@example.com" },
    ]);
  });

  it("skips what is not an address rather than yielding a blank one", () => {
    expect(parseAddressList("Undisclosed recipients:;, ada@example.com")).toEqual([
      { address: "ada@example.com" },
    ]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("   ")).toEqual([]);
  });

  it("sanitises a display name the same way the reader's does", () => {
    // A name is rendered in the recipient list, so it goes through the same strip as
    // the sender's. `U+202E` is the oldest display-name spoofing trick there is: it
    // renders a name as something other than what it is. `U+200B` is the zero-width
    // space, which hides a difference rather than showing one.
    expect(parseAddressList("A\u202Eda <ada@example.com>")[0].name).toBe("Ada");
    expect(parseAddressList("A\u200Bda <ada@example.com>")[0].name).toBe("Ada");
  });
});

describe("sanitizeDisplayName", () => {
  it("keeps ordinary non-ASCII, which is a legitimate name", () => {
    expect(sanitizeDisplayName("Tomás Lindqvist")).toBe("Tomás Lindqvist");
  });

  it("caps a name at the RFC 5322 length", () => {
    expect(sanitizeDisplayName("a".repeat(200))).toHaveLength(128);
  });
});

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
    // Bytes already in the message; nothing left the machine.
    expect(countRemoteReferences('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(0);
  });

  it("does not count a background colour", () => {
    // `background` carries a colour or a URL; only the URL is a request.
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
    // srcset is one request set, not one per candidate.
    expect(remoteReferences('<img srcset="https://a.example/1x.png 1x">')).toEqual([
      "https://a.example/1x.png 1x",
    ]);
  });

  it("reports zero for a body with nothing to fetch", () => {
    expect(countRemoteReferences("<p>Hello. <b>No images.</b></p>")).toBe(0);
    expect(countRemoteReferences("")).toBe(0);
  });

  it("does not count the strings a message merely mentions", () => {
    // Quoted HTML in text is text, not a tracking pixel.
    expect(
      countRemoteReferences('<pre>&lt;img src="https://x.example/p.gif"&gt;</pre>'),
    ).toBe(0);
  });

  /**
   * The regression this exists for: a decorative newsletter used to report three
   * blocked references while fetching nothing.
   */
  it("does not inflate the note for a decorative newsletter body", () => {
    const newsletter =
      '<table><tr><td background="#f5f5f5">' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />' +
      "</td></tr></table>";
    expect(countRemoteReferences(newsletter)).toBe(0);
  });

  /**
   * And it must not under-report either: a lone tracking pixel is the case the
   * note exists for.
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
 * `<style>` blocks are the other half of the counter; without them a message that
 * fetches the most reports zero.
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
    // `@import url(x)` matches both patterns; a double-count is the same class of
    // lie as an under-count.
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
    // Escaped HTML in the text is text, not a stylesheet.
    const html = "<pre>&lt;style&gt;a{background:url(https://x.example/a.png)}&lt;/style&gt;</pre>";
    expect(countRemoteReferences(html)).toBe(0);
  });
});

describe("tidyPlainText", () => {
  it("drops preheader padding, encoded or not", () => {
    const pad = "\u034f \u034f \u034f &shy; \u034f \u034f &shy;";
    const text = `Restaurants everyone is loving\nTake a look at these trending restaurants\n\n${pad}\n${pad}\n${pad}\n\nSee all`;
    expect(tidyPlainText(text)).toBe(
      "Restaurants everyone is loving\nTake a look at these trending restaurants\n\nSee all",
    );
  });
  it("keeps real text, typed entities and emoji sequences", () => {
    expect(tidyPlainText("AT&amp;T &lt;3")).toBe("AT&amp;T &lt;3");
    expect(tidyPlainText("family 👨\u200d👩\u200d👧 here")).toBe("family 👨\u200d👩\u200d👧 here");
    expect(tidyPlainText("co\u00adop")).toBe("coop");
  });
  it("is applied to text made from HTML", () => {
    expect(plainTextFromHtml("<p>Hi</p><div>&#847; &nbsp;&shy; &#847;</div><p>Bye</p>")).toBe("Hi\n\nBye");
  });
});
