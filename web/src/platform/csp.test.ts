import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, cspDirectives } from "./csp";

const directive = (name: string, options = {}) => cspDirectives(options).find(([n]) => n === name)?.[1] ?? [];

describe("the web CSP", () => {
  it("allows scripts from the app only: no inline script, no eval", () => {
    expect(directive("script-src")).toEqual(["'self'"]);
    const policy = contentSecurityPolicy();
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("connects only to Google's APIs and the DoH resolver", () => {
    expect(directive("connect-src")).toEqual([
      "'self'",
      "https://gmail.googleapis.com",
      "https://oauth2.googleapis.com",
      "https://people.googleapis.com",
      "https://cloudflare-dns.com",
    ]);
  });

  it("adds the render proxy's origin, and only a real http(s) one", () => {
    expect(directive("connect-src", { renderProxy: "https://render.example/api/" })).toContain("https://render.example");
    expect(directive("connect-src", { renderProxy: "javascript:alert(1)" })).toHaveLength(5);
    expect(directive("connect-src", { renderProxy: "" })).toHaveLength(5);
  });

  it("keeps images to https, data: and blob: — never plain http", () => {
    expect(directive("img-src")).toEqual(["'self'", "data:", "blob:", "https:"]);
  });

  it("is exactly this policy", () => {
    expect(contentSecurityPolicy()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; font-src 'self' data:; " +
        "connect-src 'self' https://gmail.googleapis.com https://oauth2.googleapis.com https://people.googleapis.com https://cloudflare-dns.com; " +
        "frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(contentSecurityPolicy({ renderProxy: "https://render.example:8443/x", header: true })).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; font-src 'self' data:; " +
        "connect-src 'self' https://gmail.googleapis.com https://oauth2.googleapis.com https://people.googleapis.com https://cloudflare-dns.com https://render.example:8443; " +
        "frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("refuses plugins, <base> and forms, and framing in the header form", () => {
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'none'"]);
    expect(directive("form-action")).toEqual(["'none'"]);
    expect(contentSecurityPolicy()).not.toContain("frame-ancestors");
    expect(contentSecurityPolicy({ header: true })).toContain("frame-ancestors 'none'");
  });

  it("covers every API origin the code talks to", () => {
    const sources = ["../core/gmail/dto.ts", "../core/gmail/people.ts", "../core/avatars/bimi.ts"]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");
    // Scopes and console links are names and pages, not endpoints the app fetches.
    const notFetched = ["https://www.googleapis.com", "https://accounts.google.com", "https://console.cloud.google.com"];
    const used = new Set(
      [...sources.matchAll(/export const [A-Z_]+ = "(https:\/\/[^/"]+)[^"]*"/g)]
        .map((match) => match[1]!)
        .filter((origin) => !notFetched.includes(origin)),
    );
    const allowed = directive("connect-src");
    expect([...used].filter((origin) => !allowed.includes(origin))).toEqual([]);
  });
});
