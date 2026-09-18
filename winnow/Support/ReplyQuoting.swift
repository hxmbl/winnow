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
        let quoted = quotedBody(original.body.isEmpty ? original.bodyHTML ?? "" : original.body)
        return quoted.isEmpty ? attribution : attribution + "\n" + quoted
    }

    /// Whether `text` currently ends with `block` verbatim — the only state in
    /// which removing it is safe.
    static func isSuffix(_ block: String, of text: String) -> Bool {
        guard !block.isEmpty else { return false }
        return text.hasSuffix(block)
    }
}