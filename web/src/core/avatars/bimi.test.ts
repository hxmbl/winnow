import { describe, expect, it, vi } from "vitest";
import {
  dohResolver,
  joinTxtData,
  lookupBimiLogo,
  organisationalDomain,
  parseBimiRecord,
  safeLogoUrl,
  senderDomain,
  type TxtAnswer,
} from "./bimi";

describe("parseBimiRecord", () => {
  it("extracts l=", () => {
    expect(parseBimiRecord("v=BIMI1; l=https://brand.example/logo.svg; a=https://brand.example/vmc.pem")).toEqual({
      kind: "logo",
      url: "https://brand.example/logo.svg",
    });
    expect(parseBimiRecord("v=BIMI1;l=https://brand.example/logo.svg")).toEqual({
      kind: "logo",
      url: "https://brand.example/logo.svg",
    });
  });

  it("reads an empty l= as declining", () => {
    expect(parseBimiRecord("v=BIMI1; l=; a=;")).toEqual({ kind: "declined" });
  });

  it("takes the first of a comma-separated list", () => {
    expect(parseBimiRecord("v=BIMI1; l=https://a.example/1.svg,https://a.example/2.svg")).toEqual({
      kind: "logo",
      url: "https://a.example/1.svg",
    });
  });

  it("rejects malformed records", () => {
    expect(parseBimiRecord("")).toBeNull();
    expect(parseBimiRecord("l=https://a.example/x.svg; v=BIMI1")).toBeNull(); // v not first
    expect(parseBimiRecord("v=BIMI2; l=https://a.example/x.svg")).toBeNull();
    expect(parseBimiRecord("v=BIMI1; l=https://a.example/x.svg; l=https://b.example/y.svg")).toBeNull();
    expect(parseBimiRecord("v=BIMI1; garbage")).toBeNull();
    expect(parseBimiRecord("v=BIMI1; a=https://a.example/vmc.pem")).toBeNull(); // no l=
    expect(parseBimiRecord("v=BIMI1; l=http://a.example/x.svg")).toBeNull(); // not https
    expect(parseBimiRecord("v=BIMI1; l=javascript:alert(1)")).toBeNull();
    expect(parseBimiRecord("v=spf1 include:_spf.example ~all")).toBeNull();
  });
});

describe("safeLogoUrl", () => {
  it("requires https, no credentials and a bounded length", () => {
    expect(safeLogoUrl("https://a.example/x.svg")).toBe("https://a.example/x.svg");
    expect(safeLogoUrl("http://a.example/x.svg")).toBeUndefined();
    expect(safeLogoUrl("data:image/svg+xml,<svg/>")).toBeUndefined();
    expect(safeLogoUrl("https://user:pw@a.example/x.svg")).toBeUndefined();
    expect(safeLogoUrl(`https://a.example/${"x".repeat(3000)}.svg`)).toBeUndefined();
  });
});

describe("joinTxtData", () => {
  it("joins split character-strings and unescapes", () => {
    expect(joinTxtData('"v=BIMI1; l=https://a.example/" "logo.svg"')).toBe("v=BIMI1; l=https://a.example/logo.svg");
    expect(joinTxtData('"say \\"hi\\""')).toBe('say "hi"');
    expect(joinTxtData("v=BIMI1; l=")).toBe("v=BIMI1; l=");
  });
});

describe("domains", () => {
  it("finds the organisational domain", () => {
    expect(organisationalDomain("mail.news.example.com")).toBe("example.com");
    expect(organisationalDomain("example.com")).toBe("example.com");
    expect(organisationalDomain("news.brand.co.uk")).toBe("brand.co.uk");
    expect(organisationalDomain("brand.co.uk")).toBe("brand.co.uk");
  });

  it("takes the domain from an address", () => {
    expect(senderDomain("Deals@Shop.Example")).toBe("shop.example");
    expect(senderDomain("no-domain")).toBeNull();
    expect(senderDomain("registry@example")).toBeNull();
    expect(senderDomain("x@bad_domain.com")).toBeNull();
  });
});

describe("lookupBimiLogo", () => {
  const table = (records: Record<string, string[]>) =>
    vi.fn(async (name: string): Promise<TxtAnswer> =>
      records[name] ? { kind: "records", records: records[name] } : { kind: "none" },
    );

  it("uses the sender domain's record", async () => {
    const resolve = table({ "default._bimi.news.brand.example": ["v=BIMI1; l=https://cdn.example/news.svg"] });
    expect(await lookupBimiLogo("news.brand.example", resolve)).toBe("https://cdn.example/news.svg");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("falls back to the organisational domain when the subdomain has none", async () => {
    const resolve = table({ "default._bimi.brand.example": ["v=BIMI1; l=https://cdn.example/brand.svg"] });
    expect(await lookupBimiLogo("mail.news.brand.example", resolve)).toBe("https://cdn.example/brand.svg");
    expect(resolve.mock.calls.map((c) => c[0])).toEqual([
      "default._bimi.mail.news.brand.example",
      "default._bimi.brand.example",
    ]);
  });

  it("does not fall back past a declining or broken subdomain record", async () => {
    const declined = table({
      "default._bimi.news.brand.example": ["v=BIMI1; l="],
      "default._bimi.brand.example": ["v=BIMI1; l=https://cdn.example/brand.svg"],
    });
    expect(await lookupBimiLogo("news.brand.example", declined)).toBeNull();
    const broken = table({
      "default._bimi.news.brand.example": ["v=BIMI1; l=http://insecure.example/x.svg"],
      "default._bimi.brand.example": ["v=BIMI1; l=https://cdn.example/brand.svg"],
    });
    expect(await lookupBimiLogo("news.brand.example", broken)).toBeNull();
  });

  it("returns null when nothing is published, ignores other TXT records, and refuses duplicates", async () => {
    expect(await lookupBimiLogo("plain.example", table({}))).toBeNull();
    const mixed = table({ "default._bimi.mixed.example": ["google-site-verification=x", "v=BIMI1; l=https://m.example/l.svg"] });
    expect(await lookupBimiLogo("mixed.example", mixed)).toBe("https://m.example/l.svg");
    const dup = table({
      "default._bimi.dup.example": ["v=BIMI1; l=https://d.example/1.svg", "v=BIMI1; l=https://d.example/2.svg"],
    });
    expect(await lookupBimiLogo("dup.example", dup)).toBeNull();
  });
});

describe("dohResolver", () => {
  const respond = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("asks for TXT with the JSON accept header and joins answers", async () => {
    const fetchImpl = respond({
      Status: 0,
      Answer: [
        { type: 5, data: "alias.example." },
        { type: 16, data: '"v=BIMI1; l=https://a.example/" "x.svg"' },
      ],
    });
    const resolve = dohResolver(fetchImpl, "https://doh.test/dns-query");
    expect(await resolve("default._bimi.a.example")).toEqual({
      kind: "records",
      records: ["v=BIMI1; l=https://a.example/x.svg"],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://doh.test/dns-query?name=default._bimi.a.example&type=TXT");
    expect((init.headers as Record<string, string>).accept).toBe("application/dns-json");
  });

  it("reads NXDOMAIN and an empty answer as none, and throws on failures", async () => {
    expect(await dohResolver(respond({ Status: 3 }))("x")).toEqual({ kind: "none" });
    expect(await dohResolver(respond({ Status: 0 }))("x")).toEqual({ kind: "none" });
    await expect(dohResolver(respond({ Status: 2 }))("x")).rejects.toThrow();
    await expect(dohResolver(respond({}, 503))("x")).rejects.toThrow();
  });
});

describe("senderDomain, awkward addresses", () => {
  it("converts an internationalised domain to the name DNS knows", () => {
    expect(senderDomain("info@bücher.de")).toBe("xn--bcher-kva.de");
    expect(senderDomain("INFO@BÜCHER.DE")).toBe("xn--bcher-kva.de");
  });

  it("keeps an already-punycoded domain as it is", () => {
    expect(senderDomain("a@xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
  });

  it("lower-cases and keeps subdomains", () => {
    expect(senderDomain("News@Mail.News.Brand.CO.UK")).toBe("mail.news.brand.co.uk");
  });

  it("reads through a display-name wrapper and a trailing dot", () => {
    expect(senderDomain("Ana <ana@example.com>")).toBe("example.com");
    expect(senderDomain("ana@example.com.")).toBe("example.com");
  });

  it("refuses IP literals, empty labels, hyphen-edged labels and empty domains", () => {
    expect(senderDomain("a@192.0.2.1")).toBeNull();
    expect(senderDomain("a@[192.0.2.1]")).toBeNull();
    expect(senderDomain("a@example..com")).toBeNull();
    expect(senderDomain("a@-bad.example")).toBeNull();
    expect(senderDomain("a@bad-.example")).toBeNull();
    expect(senderDomain("a@")).toBeNull();
    expect(senderDomain("")).toBeNull();
    expect(senderDomain("@")).toBeNull();
  });

  it("uses the last @ for a quoted local part", () => {
    expect(senderDomain('"a@b"@example.org')).toBe("example.org");
  });

  it("refuses an over-long label", () => {
    expect(senderDomain(`a@${"x".repeat(64)}.example`)).toBeNull();
  });
});
