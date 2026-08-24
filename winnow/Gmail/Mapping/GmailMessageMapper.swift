import Foundation

/// Maps Gmail API messages onto Winnow's UI-level `WinnowEmail` struct.
///
/// LOGIC NOTES (kept explicit because this is where two data models meet)
/// - **Identity**: Gmail ids are opaque strings; `WinnowEmail.id` is an `Int`.
///   We derive the numeric id with a stable 64-bit FNV-1a hash of the Gmail
///   id. The full string id is retained in the persistence layer
///   (`StoredEmail.gmailId`) and *always* used for API round-trips — the hash
///   is a UI key, never an API key. 64-bit space ⇒ collisions are vanishingly
///   unlikely at inbox scale, and the cache is keyed by the string id anyway.
/// - **Body**: prefers `text/plain`; falls back to `text/html` run through a
///   conservative tag-stripper (no HTML rendering anywhere in Winnow, so the
///   strip is lossy by design — markup must never reach the classifier).
/// - **Sender**: `From:` header is parsed into display name + address; the
///   *address* becomes `sender` (what the profile/classifier key on), matching
///   how the mock data's real-address entries behave.
/// - **Flags**: `STARRED` label → `starred`. Gmail's `CATEGORY_PROMOTIONS` is
///   honored as `type: "promotional"` because Gmail's own classifier is a
///   legitimate signal; all other labels are ignored here and left to the
///   rule engine.
/// - Trashed messages are never mapped — the sync engine filters them before
///   this runs, so the classifier never sees deleted mail.
enum GmailMessageMapper {
    nonisolated static func winnowEmail(from message: GmailMessage) -> WinnowEmail? {
        guard !message.hasLabel(GmailLabel.trash) else { return nil }

        let headers = Dictionary(
            (message.payload?.headers ?? []).map { ($0.name.lowercased(), $0.value) },
            uniquingKeysWith: { _, last in last }
        )

        let from = Self.parseFrom(headers["from"] ?? "")
        let receivedAtMs = Self.receivedAtMs(internalDate: message.internalDate, dateHeader: headers["date"])
        let body = Self.body(of: message, fallbackSnippet: message.snippet ?? "")

        return WinnowEmail(
            id: stableNumericID(for: message.id),
            sender: from.address,
            name: from.name,
            email: from.address,
            receivedAt: receivedAtMs,
            subject: headers["subject"] ?? "(no subject)",
            body: body,
            type: message.hasLabel(GmailLabel.categoryPromotions) ? "promotional" : "",
            starred: message.hasLabel(GmailLabel.starred),
            urgent: false
        )
    }

    /// Stable 64-bit FNV-1a over the Gmail id, truncated to `Int`.
    nonisolated static func stableNumericID(for gmailID: String) -> Int {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in gmailID.utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
        }
        return Int(truncatingIfNeeded: hash)
    }

    /// `"Name" <a@b.c>`, `Name <a@b.c>`, and bare `a@b.c` all resolve to
    /// (name?, address). Unparseable input yields an empty-address email,
    /// which the classifier already treats with suspicion.
    nonisolated static func parseFrom(_ raw: String) -> (name: String?, address: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("@") else { return (nil, trimmed) }

        if let open = trimmed.lastIndex(of: "<"), let close = trimmed.firstIndex(of: ">"), open < close {
            let address = String(trimmed[trimmed.index(after: open)..<close])
            var name = String(trimmed[trimmed.startIndex..<open]).trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
                name = String(name.dropFirst().dropLast())
            }
            return (name.isEmpty ? nil : name, address)
        }
        return (nil, trimmed)
    }

    nonisolated static func receivedAtMs(internalDate: String?, dateHeader: String?) -> Int {
        if let internalDate, let ms = Int(internalDate) { return ms }
        if let dateHeader {
            let formats = ["EEE, d MMM yyyy HH:mm:ss Z", "d MMM yyyy HH:mm:ss Z"]
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            for format in formats {
                formatter.dateFormat = format
                if let date = formatter.date(from: dateHeader) {
                    return Int(date.timeIntervalSince1970 * 1000)
                }
            }
        }
        return Int(Date().timeIntervalSince1970 * 1000)
    }

    /// Depth-first search of Gmail's MIME tree for the first `text/plain`
    /// leaf, else the first `text/html` leaf (stripped), else the snippet.
    nonisolated static func body(of message: GmailMessage, fallbackSnippet: String) -> String {
        var plain: String?
        var html: String?

        func visit(_ part: GmailMessagePart?) {
            guard let part else { return }
            if part.mimeType == "text/plain", plain == nil, let data = part.body?.data.flatMap(Base64URL.decode) {
                plain = String(data: data, encoding: .utf8)
            }
            if part.mimeType == "text/html", html == nil, let data = part.body?.data.flatMap(Base64URL.decode) {
                html = String(data: data, encoding: .utf8)
            }
            part.parts?.forEach(visit)
        }
        visit(message.payload)

        if let plain, !plain.isEmpty { return plain }
        if let html, let stripped = stripHTML(html), !stripped.isEmpty { return stripped }
        return fallbackSnippet
    }

    /// Conservative HTML→text: drops `script`/`style` wholesale, removes all
    /// remaining tags, decodes the handful of entities that appear constantly,
    /// and collapses whitespace. Never renders markup.
    nonisolated static func stripHTML(_ html: String) -> String? {
        var text = html
        for tag in ["script", "style", "head"] {
            if let range = text.range(of: "<\(tag)[\\s\\S]*?</\(tag)>", options: [.regularExpression, .caseInsensitive]) {
                text.replaceSubrange(range, with: " ")
            }
        }
        text = text.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        let entities = [
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
            "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
        ]
        for (entity, replacement) in entities {
            text = text.replacingOccurrences(of: entity, with: replacement)
        }
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
