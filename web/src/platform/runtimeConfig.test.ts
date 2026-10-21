import { describe, expect, it } from "vitest";
import {
  EMPTY_RUNTIME_CONFIG,
  RUNTIME_CONFIG_META,
  normaliseProxyUrl,
  parseRuntimeConfig,
  readRuntimeConfig,
  resolveRenderProxy,
} from "./runtimeConfig";

/** A document holding one `<meta name="winnow-config">`, or none. */
const page = (content: string | null) => ({
  querySelector: (selector: string) =>
    content !== null && selector === `meta[name="${RUNTIME_CONFIG_META}"]` ? { getAttribute: () => content } : null,
});

describe("runtime configuration", () => {
  it("is empty when the page carries none, as in dev, Tauri and a plain static host", () => {
    expect(readRuntimeConfig(page(null))).toEqual(EMPTY_RUNTIME_CONFIG);
    expect(readRuntimeConfig(undefined)).toEqual(EMPTY_RUNTIME_CONFIG);
    // vitest runs in Node: no document at all.
    expect(readRuntimeConfig()).toEqual(EMPTY_RUNTIME_CONFIG);
    expect(parseRuntimeConfig(undefined)).toEqual(EMPTY_RUNTIME_CONFIG);
    expect(parseRuntimeConfig({ distribution: "docker" })).toEqual(EMPTY_RUNTIME_CONFIG);
  });

  it("reads what the Docker image writes", () => {
    expect(readRuntimeConfig(page("distribution=docker; updates=pinned; renderProxy=self"))).toEqual({
      distribution: "docker",
      updates: "pinned",
      renderProxy: "self",
    });
    expect(parseRuntimeConfig("distribution=docker; updates=auto; renderProxy=https://render.example:8443/x").renderProxy).toBe(
      "https://render.example:8443/x",
    );
  });

  it("keeps only values that are what they claim", () => {
    expect(parseRuntimeConfig("distribution=flatpak; updates=auto")).toEqual(EMPTY_RUNTIME_CONFIG);
    // Docker without a known update mode is the default one.
    expect(parseRuntimeConfig("distribution=docker; updates=nightly").updates).toBe("auto");
    expect(parseRuntimeConfig("distribution=docker; renderProxy=").renderProxy).toBeNull();
    expect(parseRuntimeConfig("garbage;;=x;distribution=docker").distribution).toBe("docker");
    // The first of a repeated key wins.
    expect(parseRuntimeConfig("distribution=docker; updates=image; updates=auto").updates).toBe("image");
  });

  it("survives a document that throws when read", () => {
    const broken = {
      querySelector: () => {
        throw new Error("no");
      },
    };
    expect(readRuntimeConfig(broken)).toEqual(EMPTY_RUNTIME_CONFIG);
  });
});

describe("where the render proxy is", () => {
  it("prefers the runtime's value and falls back to the build's", () => {
    expect(resolveRenderProxy(null, "https://build.example/proxy/", "https://app.example")).toBe("https://build.example/proxy");
    expect(resolveRenderProxy("https://run.example", "https://build.example", "https://app.example")).toBe("https://run.example");
    expect(resolveRenderProxy(null, undefined, "https://app.example")).toBeNull();
    expect(resolveRenderProxy(null, "", "https://app.example")).toBeNull();
  });

  it("resolves self to the page's own origin, and to nothing outside http(s)", () => {
    expect(resolveRenderProxy("self", undefined, "https://mail.example:8443")).toBe("https://mail.example:8443");
    expect(resolveRenderProxy("self", undefined, "tauri://localhost")).toBeNull();
    expect(resolveRenderProxy("self", undefined, null)).toBeNull();
  });

  it("does not fall back to the build when the runtime's value is invalid", () => {
    expect(resolveRenderProxy("javascript:alert(1)", "https://build.example", "https://app.example")).toBeNull();
  });

  it("accepts only plain http(s) base URLs", () => {
    expect(normaliseProxyUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normaliseProxyUrl("https://render.example/api/")).toBe("https://render.example/api");
    expect(normaliseProxyUrl("file:///etc/passwd")).toBeNull();
    expect(normaliseProxyUrl("data:text/html,x")).toBeNull();
    expect(normaliseProxyUrl("https://user:pw@render.example")).toBeNull();
    expect(normaliseProxyUrl("https://render.example/?to=evil")).toBeNull();
    expect(normaliseProxyUrl("not a url")).toBeNull();
    expect(normaliseProxyUrl(7)).toBeNull();
  });
});
