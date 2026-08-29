import Foundation
import Testing
@testable import winnow

/// Mapper + MIME hygiene regressions (audit L2, L3, M8).
struct GmailMapperTests {

    // MARK: RFC 2047 encoded words (M8)

    @Test func asciiHeadersPassThroughUntouched() {
        #expect(MIMEBuilder.encodeHeaderValue("Quarterly report Q3") == "Quarterly report Q3")
    }

    @Test func shortNonASCIISubjectBecomesOneEncodedWord() throws {
        let encoded = MIMEBuilder.encodeHeaderValue("Réunion")
        #expect(encoded.hasPrefix("=?UTF-8?B?"))
        #expect(encoded.hasSuffix("?="))
        #expect(encoded.count <= 75)

        let decoded = try Self.decodeEncodedWords(encoded)
        #expect(decoded == "Réunion")
    }

    @Test func longNonASCIISubjectSplitsIntoWordsWithinTheRFC75CharLimit() throws {
        let subject = String(repeating: "é", count: 60) + "ünïcödé subject that keeps going and going"
        let encoded = MIMEBuilder.encodeHeaderValue(subject)

        // Every physical line is an encoded word within the limit.
        let lines = encoded.components(separatedBy: "\r\n ")
        #expect(lines.count > 1)
        for line in lines {
            #expect(line.count <= 75, "encoded word too long: \(line.count)")
            #expect(line.hasPrefix("=?UTF-8?B?") && line.hasSuffix("?="))
        }

        // And the split round-trips losslessly across UTF-8 boundaries.
        #expect(try Self.decodeEncodedWords(encoded) == subject)
    }

    private static func decodeEncodedWords(_ value: String) throws -> String {
        var decoded = ""
        for word in value.components(separatedBy: .whitespacesAndNewlines) where !word.isEmpty {
            // Each word looks like `=?UTF-8?B?<base64>?=`.
            let prefix = "=?UTF-8?B?"
            let payload = String(word.dropFirst(prefix.count).dropLast("?=".count))
            let data = try #require(Data(base64Encoded: payload))
            decoded += String(decoding: data, as: UTF8.self)
        }
        return decoded
    }

    // MARK: From-header parsing (L2)

    @Test func parseFromHandlesWellKnownShapes() {
        #expect(GmailMessageMapper.parseFrom(#""Ada Lovelace" <ada@example.com>"#).address == "ada@example.com")
        #expect(GmailMessageMapper.parseFrom(#""Ada Lovelace" <ada@example.com>"#).name == "Ada Lovelace")
        #expect(GmailMessageMapper.parseFrom("Ada <ada@example.com>").name == "Ada")
        #expect(GmailMessageMapper.parseFrom("bare@example.com").address == "bare@example.com")
    }

    @Test func parseFromSanitizesMalformedHeaders() {
        // Stray brackets/quotes from malformed headers must not leak into the
        // displayed address.
        #expect(GmailMessageMapper.parseFrom("<mangled@x.co").address == "mangled@x.co")
        #expect(GmailMessageMapper.parseFrom(#""Quoted" <q@x.co>"#).address == "q@x.co")

        // Unclosed angle bracket: whatever follows the last `<` is the address.
        let unclosed = GmailMessageMapper.parseFrom(#"Bob" <bob@x.co"#)
        #expect(unclosed.address == "bob@x.co")
        #expect(!unclosed.address.contains("\""))
    }

    // MARK: HTML stripping (L3)

    @Test func stripHTMLKeepsProseLessThanSigns() {
        #expect(GmailMessageMapper.stripHTML("3 &lt; 5 but also 3 < 5 raw") == "3 < 5 but also 3 < 5 raw")
        #expect(GmailMessageMapper.stripHTML("a < b and c > d") == "a < b and c > d")
    }

    @Test func stripHTMLStillDropsRealTags() {
        #expect(GmailMessageMapper.stripHTML("<p>Hello</p><br/><img src=\"x\"/> world") == "Hello world")
        #expect(GmailMessageMapper.stripHTML("<SCRIPT>alert(1)</SCRIPT>safe") == "safe")
        #expect(GmailMessageMapper.stripHTML("<!-- comment -->visible") == "visible")
    }

    @Test func stripHTMLDecodesNamedAndNumericEntities() {
        #expect(GmailMessageMapper.stripHTML("it&#39;s &#x27;quoted&#x27; &amp; clean") == "it's 'quoted' & clean")
    }
}
