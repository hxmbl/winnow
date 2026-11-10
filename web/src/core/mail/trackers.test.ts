import { describe, expect, it } from "vitest";
import { sanitizeMailHtml } from "./sanitize";
import { isAuthParam, isRedirectLike, isTrackingParam, stripTrackingParams, TRACKING_PARAMS } from "./trackers";

describe("stripTrackingParams: what goes", () => {
  it("removes utm_* in any case, keeping the other parameters in order", () => {
    expect(stripTrackingParams("https://shop.example/p?id=7&utm_source=news&utm_medium=email&colour=red&UTM_Campaign=x"))
      .toBe("https://shop.example/p?id=7&colour=red");
  });

  it("removes the click IDs and the Mailchimp, HubSpot and Marketo tags", () => {
    for (const name of TRACKING_PARAMS) {
      expect(stripTrackingParams(`https://site.example/a?${name}=abc&page=2`)).toBe("https://site.example/a?page=2");
    }
  });

  it("drops the `?` when nothing is left", () => {
    expect(stripTrackingParams("https://site.example/a?fbclid=1&gclid=2")).toBe("https://site.example/a");
  });

  it("matches the click-ID names case-sensitively", () => {
    const url = "https://site.example/a?FBCLID=1&Gclid=2";
    expect(stripTrackingParams(url)).toBe(url);
  });

  it("works on http as well as https", () => {
    expect(stripTrackingParams("http://site.example/?utm_source=a")).toBe("http://site.example/");
  });
});

describe("stripTrackingParams: what stays exactly as written", () => {
  it("leaves a URL with nothing to strip as the same string", () => {
    const url = "https://site.example/a/b?x=1&y=two%20words#top";
    expect(stripTrackingParams(url)).toBe(url);
    expect(stripTrackingParams("https://site.example/plain")).toBe("https://site.example/plain");
    expect(stripTrackingParams("https://site.example/?")).toBe("https://site.example/?");
  });

  it("preserves the encoding of every other parameter, byte for byte", () => {
    // URLSearchParams would turn %20 into +, ~ into %7E and decode the %2F.
    expect(stripTrackingParams("https://site.example/s?q=a%20b+c&path=%2Fx%2Fy&t=~me&e=&flag&utm_source=n"))
      .toBe("https://site.example/s?q=a%20b+c&path=%2Fx%2Fy&t=~me&e=&flag");
  });

  it("preserves the fragment, including a `?` or `&` inside it", () => {
    expect(stripTrackingParams("https://site.example/doc?utm_medium=email&v=2#section?utm_source=x&b"))
      .toBe("https://site.example/doc?v=2#section?utm_source=x&b");
    expect(stripTrackingParams("https://site.example/doc?gclid=1#frag")).toBe("https://site.example/doc#frag");
  });

  it("keeps names that are not clearly trackers", () => {
    for (const name of ["spm", "s_cid", "ref_src", "vero_id", "vero_conv", "oly_anon_id", "oly_enc_id", "_ga", "_gl", "hsCtaTracking", "ref", "source", "id"]) {
      expect(isTrackingParam(name)).toBe(false);
      const url = `https://site.example/a?${name}=1`;
      expect(stripTrackingParams(url)).toBe(url);
    }
  });

  it("does not touch mailto:, tel: or other schemes", () => {
    for (const url of ["mailto:a@b.example?subject=hi&utm_source=x", "tel:+441234?utm_source=x", "ftp://files.example/?utm_source=x"]) {
      expect(stripTrackingParams(url)).toBe(url);
    }
  });
});

describe("stripTrackingParams: signed and authenticated URLs are left whole", () => {
  const signed = [
    "sig", "signature", "X-Amz-Signature", "x-goog-signature", "hmac", "hash", "token", "auth",
    "key", "code", "state", "expires", "exp", "nonce", "otp", "verify", "Signature", "TOKEN",
    "url_sig", "access_token", "X_Refresh_Token",
  ];

  it("recognises every signature or auth name, case-insensitively", () => {
    for (const name of signed) expect(isAuthParam(name)).toBe(true);
    for (const name of ["id", "page", "tokens", "keyword", "codec", "signatures"]) expect(isAuthParam(name)).toBe(false);
  });

  it("returns the whole URL untouched, utm included, when any is present", () => {
    for (const name of signed) {
      const url = `https://cdn.example/file.pdf?utm_source=mail&${name}=abc123&fbclid=z`;
      expect(stripTrackingParams(url)).toBe(url);
    }
  });

  it("keeps an S3-style presigned URL intact", () => {
    const url =
      "https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261110%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261110T160000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&utm_source=email&X-Amz-Signature=deadbeef";
    expect(stripTrackingParams(url)).toBe(url);
  });

  it("keeps an OAuth-style callback with code and state intact", () => {
    const url = "https://app.example/cb?code=4%2F0Ab&state=xyz&utm_campaign=welcome";
    expect(stripTrackingParams(url)).toBe(url);
  });

  it("checks a percent-encoded name too", () => {
    const url = "https://app.example/x?%74oken=1&utm_source=a";
    expect(stripTrackingParams(url)).toBe(url);
  });
});

describe("stripTrackingParams: shorteners and redirects are left whole", () => {
  it("never strips from a link shortener", () => {
    for (const url of [
      "https://bit.ly/3abc?utm_source=x",
      "https://t.co/xyz?utm_source=x",
      "https://tinyurl.com/abc?fbclid=1",
      "https://lnkd.in/abc?utm_medium=a",
      "https://www.bit.ly/abc?utm_medium=a",
    ]) {
      expect(stripTrackingParams(url)).toBe(url);
    }
  });

  it("never strips from a redirect or link-safety host", () => {
    for (const url of [
      "https://eur01.safelinks.protection.outlook.com/?data=abc&utm_source=x",
      "https://urldefense.com/v3/__https://x.example__;!!abc?utm_source=x",
      "https://l.facebook.com/l.php?h=AT0&utm_source=x",
      "https://click.newsletter.example/abc123?utm_source=x",
      "https://links.shop.example/ls/click?upn=abc&utm_campaign=y",
      "https://email.vendor.example/c/abc?utm_source=x",
    ]) {
      expect(stripTrackingParams(url)).toBe(url);
    }
  });

  it("never strips from a redirect path or a URL wrapping another URL", () => {
    for (const url of [
      "https://www.google.com/url?q=https://x.example&utm_source=a",
      "https://site.example/redirect?to=home&utm_source=a",
      "https://site.example/out/123?utm_source=a",
      "https://site.example/go?u=https%3A%2F%2Fother.example%2F&utm_source=a",
      "https://site.example/page?next=%2F%2Fother.example&gclid=1",
    ]) {
      expect(stripTrackingParams(url)).toBe(url);
    }
  });

  it("does not mistake an ordinary site for a redirect", () => {
    expect(isRedirectLike("email.com", "/")).toBe(false);
    expect(isRedirectLike("shop.example", "/products/red")).toBe(false);
    expect(isRedirectLike("www.example.com", "/urls-explained")).toBe(false);
  });
});

describe("stripTrackingParams: account flows are left whole", () => {
  it("never strips when the path mentions unsubscribe, verify, confirm, reset, login, signin or magic", () => {
    for (const path of [
      "/unsubscribe", "/email/Unsubscribe/abc", "/verify-email", "/account/confirm", "/password/reset",
      "/login", "/log-in", "/signin", "/sign-in", "/auth/magic-link", "/users/sign_in",
    ]) {
      const url = `https://site.example${path}?id=1&utm_source=x`;
      expect(stripTrackingParams(url)).toBe(url);
    }
  });

  it("only looks at the path, not the host or the fragment", () => {
    expect(stripTrackingParams("https://site.example/news?utm_source=x#confirm")).toBe("https://site.example/news#confirm");
  });
});

describe("sanitizeMailHtml with stripLinkTrackers", () => {
  const body = '<p><a href="https://shop.example/sale?utm_source=news&amp;id=9&amp;fbclid=abc#deal">Sale</a></p>';

  it("cleans the href in the markup itself, so a modified click gets the clean link", () => {
    // RichBody's click handler returns early on Cmd/Ctrl/Shift/Alt clicks and lets the
    // browser follow the anchor's own href, so the document must already hold the clean one.
    const { html } = sanitizeMailHtml(body, { stripLinkTrackers: true });
    expect(html).toContain('href="https://shop.example/sale?id=9#deal"');
    expect(html).not.toMatch(/utm_source|fbclid/);
  });

  it("leaves the href exactly as before when off, which is the sanitiser's default", () => {
    const expected = 'href="https://shop.example/sale?utm_source=news&amp;id=9&amp;fbclid=abc#deal"';
    expect(sanitizeMailHtml(body).html).toContain(expected);
    expect(sanitizeMailHtml(body, { stripLinkTrackers: false }).html).toContain(expected);
  });

  it("cleans a protocol-relative link once it is allowed", () => {
    const { html } = sanitizeMailHtml('<a href="//shop.example/?gclid=1&amp;a=2">x</a>', { allowRemote: true, stripLinkTrackers: true });
    expect(html).toContain('href="https://shop.example/?a=2"');
  });

  it("keeps a signed link and a mailto: link whole", () => {
    const signed = '<a href="https://cdn.example/f?utm_source=x&amp;sig=abc">f</a><a href="mailto:a@b.example?utm_source=x">m</a>';
    const { html } = sanitizeMailHtml(signed, { stripLinkTrackers: true });
    expect(html).toContain('href="https://cdn.example/f?utm_source=x&amp;sig=abc"');
    expect(html).toContain('href="mailto:a@b.example?utm_source=x"');
  });

  it("does not change image addresses, only links", () => {
    const { html } = sanitizeMailHtml('<img src="https://img.example/p.png?utm_source=x">', { allowRemote: true, stripLinkTrackers: true });
    expect(html).toContain('src="https://img.example/p.png?utm_source=x"');
  });
});
