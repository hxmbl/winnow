import { describe, expect, it } from "vitest";
import {
  EMPTY_RUNTIME_CONFIG,
  RUNTIME_CONFIG_GLOBAL,
  normaliseProxyUrl,
  parseRuntimeConfig,
  readRuntimeConfig,
  resolveRenderProxy,
} from "./runtimeConfig";

describe("runtime configuration", () => {
  it("is empty when the page defines none, as in dev, Tauri and a plain static host", () => {
    expect(readRuntimeConfig({})).toEqual(EMPTY_RUNTIME_CONFIG);
    expect(parseRuntimeConfig(undefined)).toEqual(EMPTY_RUNTIME_CONFIG);
    expect(parseRuntimeConfig("docker")).toEqual(EMPTY_RUNTIME_CONFIG);
    expect(parseRuntimeConfig(null)).toEqual(EMPTY_RUNTIME_CONFIG);
  });

  it("reads what the Docker image writes", () => {
    const scope = {
      [RUNTIME_CONFIG_GLOBAL]: Object.freeze({ distribution: "docker", updates: "pinned", renderProxy: "self" }),
    };
    expect(readRuntimeConfig(scope)).toEqual({ distribution: "docker", updates: "pinned", renderProxy: "self" });
  });

  it("keeps only values that are what they claim", () => {
    expect(parseRuntimeConfig({ distribution: "flatpak", updates: "auto", renderProxy: 42 })).toEqual(EMPTY_RUNTIME_CONFIG);
    // Docker without a known update mode is the default one.
    expect(parseRuntimeConfig({ distribution: "docker", updates: "nightly" }).updates).toBe("auto");
    expect(parseRuntimeConfig({ distribution: "docker", renderProxy: "   " }).renderProxy).toBeNull();
  });

  it("survives a global that throws when read", () => {
    const scope = Object.defineProperty({}, RUNTIME_CONFIG_GLOBAL, {
      get() {
        throw new Error("no");
      },
    });
    expect(readRuntimeConfig(scope)).toEqual(EMPTY_RUNTIME_CONFIG);
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
