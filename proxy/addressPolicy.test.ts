/**
 * The render proxy's address policy.
 *
 * This is the security boundary of a service that fetches URLs chosen by whoever
 * sent you mail, so the tests are the threat model: loopback, the private network,
 * cloud metadata, and the three ways an IPv6 literal wraps an IPv4 address so that
 * a filter reading the text sees an unfamiliar name rather than `127.0.0.1`.
 *
 * The cases that are *allowed* matter as much as the ones refused. A policy that
 * refuses `1.1.1.1` alongside `127.0.0.1` is not safer, it is a proxy that renders
 * nothing, and a reader who cannot see a newsletter will turn remote content off
 * everywhere and lose the privacy win this service is for.
 */

import { describe, expect, it } from "vitest";
import { checkUrl, isAssetContentType, isPublicAddress } from "./addressPolicy";

describe("IPv4", () => {
  it("refuses everything on the inside of a machine or a network", () => {
    for (const host of [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.254",
      "100.64.0.1", // carrier NAT
      "127.0.0.1",
      "127.1.2.3",
      // The one that matters most: the cloud metadata endpoint. One fetch of it
      // from an unauthenticated service hands over the instance's credentials.
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast
    ]) {
      expect(isPublicAddress(host), `${host} must be refused`).toBe(false);
    }
  });

  it("allows ordinary public addresses, including the edges of each blocked block", () => {
    for (const host of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "9.255.255.255", // just below 10/8
      "11.0.0.0", // just above
      "126.255.255.255", // just below 127/8
      "128.0.0.1", // just above
      "169.253.255.255", // just below link-local
      "169.255.0.0", // just above
      "172.15.255.255", // just below 172.16/12
      "172.32.0.0", // just above
      "192.167.255.255", // just below 192.168/16
      "192.169.0.0", // just above
      "223.255.255.255", // just below multicast
    ]) {
      expect(isPublicAddress(host), `${host} must be allowed`).toBe(true);
    }
  });

  it("refuses something that is not an address at all", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

describe("IPv6", () => {
  it("refuses loopback, unspecified, unique-local, link-local and multicast", () => {
    for (const host of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isPublicAddress(host), `${host} must be refused`).toBe(false);
    }
  });

  it("sees through an IPv4-mapped address", () => {
    // A dual-stack socket asking for an IPv4 address is handed one of these, so it
    // is not an exotic spelling — it is what the resolver returns routinely.
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    // And a *public* address in the same form stays allowed. The rule is about
    // where the address points, not about how neatly it is written.
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
  });

  it("sees through NAT64 and 6to4", () => {
    expect(isPublicAddress("64:ff9b::127.0.0.1")).toBe(false);
    expect(isPublicAddress("2002:7f00:0001::1")).toBe(false);
    expect(isPublicAddress("64:ff9b::5db8:d822")).toBe(true);
  });

  it("allows an ordinary global address", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("refuses something that is not an address", () => {
    expect(isPublicAddress("::gggg")).toBe(false);
    expect(isPublicAddress("fe80::1%eth0")).toBe(false);
    expect(isPublicAddress("fe80::1%25eth0")).toBe(false);
  });
});

describe("checkUrl", () => {
  it("allows http and https", () => {
    expect(checkUrl("https://cdn.example.test/a.png").ok).toBe(true);
    // Plain HTTP is allowed on purpose: half the images in a newsletter are on a
    // host that never got a certificate, and the point of the proxy is that the
    // *proxy* makes that request rather than the reader's browser.
    expect(checkUrl("http://cdn.example.test/a.png").ok).toBe(true);
  });

  it("refuses every scheme that is not a fetch", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.test/a.png",
      "data:image/png;base64,iVBOR",
      "gopher://example.test/",
      "javascript:alert(1)",
    ]) {
      const verdict = checkUrl(url);
      expect(verdict.ok, `${url} must be refused`).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("scheme");
    }
  });

  it("refuses credentials in the URL", () => {
    // A URL that will send an Authorization header to a host the sender chose, from
    // a service the reader vouched for. Mail has no use for it.
    const verdict = checkUrl("https://user:secret@cdn.example.test/a.png");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("credentials");
  });

  it("refuses a literal that points inside the machine, before any DNS", () => {
    const verdict = checkUrl("http://127.0.0.1:8080/admin");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("address");
  });

  it("refuses a malformed URL rather than throwing", () => {
    const verdict = checkUrl("http://");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("malformed");
  });

  it("leaves a hostname for the caller to resolve", () => {
    // Judging the text of a name proves only that the text is innocent. The
    // resolution is the server's job and this function says so by allowing it.
    expect(checkUrl("https://cdn.example.test/a.png").ok).toBe(true);
    expect(checkUrl("http://localhost/a.png").ok).toBe(true);
  });
});

describe("content types", () => {
  it("takes the raster formats and refuses everything else", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon"]) {
      expect(isAssetContentType(type), type).toBe(true);
    }
    for (const type of [
      "text/html",
      "application/javascript",
      "image/svg+xml", // a document that can script
      "application/pdf",
      "",
    ]) {
      expect(isAssetContentType(type), type).toBe(false);
    }
  });
});