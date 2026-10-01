import Foundation

/// Builds the "On <date>, <name> wrote:" block that quoting a message inserts
/// into the reply composer. Extracted so the reply pipeline is a pure function
/// the tests can drive without a UI.
///
/// DESIGN (STO-125)
/// - The quote is **real text** inserted into the editable reply body — not an
///   overlay — so the user can trim or edit the quoted original freely.
/// - Removal is explicit: the composer tracks the exact block it inserted and
///   strips it only while it still suffixes the text verbatim. If the user
///   edited inside the quote, the flag stays but the block is left as text
///   (removing it would silently delete their edits).
enum ReplyQuoting {
    /// The "On …, X wrote:" line. Uses the same date formatter as list rows so
    /// the attribution reads identically to the header.
    static func attributionLine(receivedAtMs: Int, displayName: String) -> String {
        "On \(formatListTime(receivedAtMs)), \(displayName) wrote:"
    }

    /// Quotes a message body: every line prefixed with "> " (blank lines become a
    /// bare ">", matching mail conventions without trailing whitespace).
    static func quotedBody(_ body: String) -> String {
        body.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.isEmpty ? ">" : "> \($0)" }
            .joined(separator: "\n")
    }

    /// The full quotable block for one message, attribution line first.
    static func block(original: WinnowEmail) -> String {
        let attribution = attributionLine(receivedAtMs: original.receivedAt, displayName: original.displayName)
        let source = original.body.isEmpty ? plainText(fromHTML: original.bodyHTML ?? "") : original.body
        let quoted = quotedBody(source)
        return quoted.isEmpty ? attribution : attribution + "\n" + quoted
    }

    /// Converts an HTML body to readable plain text for quoting. Keeps the
    /// block structure (line breaks for `<br>`, paragraphs, list items, rows)
    /// but strips tags, scripts/styles and entities, so the composer never
    /// gets a wall of raw markup. The previous raw-HTML fallback leaked
    /// hostile markup straight into the editable reply.
    static func plainText(fromHTML html: String) -> String {
        var text = html
        for container in ["script", "style", "head"] {
            text = text.replacingOccurrences(
                of: "<\(container)[^>]*>[\\s\\S]*?</\(container)>",
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        text = text.replacingOccurrences(
            of: "<(br|/p|/div|/li|/tr|/h[1-6])[^>]*>",
            with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        text = decodeHTMLEntities(text)
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func decodeHTMLEntities(_ text: String) -> String {
        var result = text
        let named = [
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
            "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&mdash;": "—",
            "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘",
            "&ldquo;": "“", "&rdquo;": "”"
        ]
        for (entity, replacement) in named {
            result = result.replacingOccurrences(of: entity, with: replacement)
        }
        let pattern = "&#(x?)([0-9A-Fa-f]+);"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return result }
        let matches = regex.matches(in: result, range: NSRange(result.startIndex..<result.endIndex, in: result))
        for match in matches.reversed() {
            guard let full = Range(match.range, in: result),
                  let radixRange = Range(match.range(at: 1), in: result),
                  let digitsRange = Range(match.range(at: 2), in: result),
                  let value = UInt32(result[digitsRange], radix: result[radixRange].isEmpty ? 10 : 16),
                  let scalar = Unicode.Scalar(value) else { continue }
            result.replaceSubrange(full, with: String(Character(scalar)))
        }
        return result
    }

    /// Whether `text` currently ends with `block` verbatim — the only state in
    /// which removing it is safe.
    static func isSuffix(_ block: String, of text: String) -> Bool {
        guard !block.isEmpty else { return false }
        return text.hasSuffix(block)
    }
}
