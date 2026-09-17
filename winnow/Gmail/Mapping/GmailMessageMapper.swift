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
/// - **Body**: prefers the *longest* `text/plain` leaf (some senders put the
///   real content in a later part and an empty stub first); falls back to
///   `text/html` run through a conservative tag-stripper (markup must never
///   reach the classifier — `body`, the signal/search source, stays plain
///   text even when the reader shows HTML). The raw HTML is retained as
///   `bodyHTML` for the sandboxed reader to surface without re-fetching.
/// - **Sender**: `From:` header is parsed into display name + address; the
///   *address* becomes `sender` (what the profile/classifier key on), matching
///   how the mock data's real-address entries behave.
/// - **Flags**: `STARRED` label → `starred`; `UNREAD` label → `unread`.
///   Gmail's `CATEGORY_PROMOTIONS` is honored as `type: "promotional"` because
///   Gmail's own classifier is a legitimate signal; all other labels are
///   ignored here and left to the rule engine.
/// - **Mailbox**: derived from labels via `mailbox(of:)` — TRASH dominates,
///   then INBOX, else archived. Trash is mapped (the Trash mailbox needs it);
///   the *store* decides which buckets each mailbox view reads.
/// - **Attachments**: any MIME leaf with an `attachmentId` (or an inline
///   part with a filename) becomes metadata. Payload bytes are fetched
///   lazily by the reader via `GmailClient.attachment(...)`.
enum GmailMessageMapper {
    nonisolated static func winnowEmail(from message: GmailMessage) -> WinnowEmail? {
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
            urgent: false,
            unread: message.hasLabel(GmailLabel.unread),
            bodyHTML: htmlBody(of: message),
            attachments: attachments(of: message)
        )
    }

    /// The mailbox a message lives in, per Gmail's label semantics.
    nonisolated static func mailbox(of message: GmailMessage) -> EmailMailbox {
        if message.hasLabel(GmailLabel.trash) { return .trash }
        if message.hasLabel(GmailLabel.inbox) { return .inbox }
        return .archive
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
            var name = String(trimmed[trimmed.startIndex..<open]).trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
                name = String(name.dropFirst().dropLast())
            }
            return (name.isEmpty ? nil : name, sanitizeAddress(trimmed[trimmed.index(after: open)..<close]))
        }
        // Unclosed `<`: whatever follows it is the best address candidate.
        if let open = trimmed.lastIndex(of: "<") {
            return (nil, sanitizeAddress(trimmed[trimmed.index(after: open)...]))
        }
        return (nil, sanitizeAddress(trimmed[...]))
    }

    /// Display-only hygiene: malformed headers must not leak angle brackets
    /// or stray quotes into what the UI shows as an address.
    private nonisolated static func sanitizeAddress(_ raw: Substring) -> String {
        let stripped = raw
            .replacingOccurrences(of: "<", with: "")
            .replacingOccurrences(of: ">", with: "")
        return stripped.trimmingCharacters(in: CharacterSet(charactersIn: " \t\""))
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

    /// Depth-first search of Gmail's MIME tree for the **longest** `text/plain`
    /// leaf, else the first `text/html` leaf (stripped), else the snippet.
    nonisolated static func body(of message: GmailMessage, fallbackSnippet: String) -> String {
        var plain: String?
        var plainLen = 0
        var html: String?

        func visit(_ part: GmailMessagePart?) {
            guard let part else { return }
            if part.mimeType == "text/plain", let data = part.body?.data.flatMap(Base64URL.decode),
               let text = String(data: data, encoding: .utf8), text.count > plainLen {
                plain = text
                plainLen = text.count
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

    /// The raw `text/html` body, if any. Stored for the sandboxed reader to
    /// surface without re-fetching; rendering happens in a WKWebView with
    /// JavaScript disabled (see `EmailHTMLBodyView`).
    nonisolated static func htmlBody(of message: GmailMessage) -> String? {
        var result: String?
        func visit(_ part: GmailMessagePart?) {
            guard let part, result == nil else { return }
            if part.mimeType == "text/html", let data = part.body?.data.flatMap(Base64URL.decode) {
                result = String(data: data, encoding: .utf8)
            }
            part.parts?.forEach(visit)
        }
        visit(message.payload)
        return result
    }

    /// Collects attachment metadata from the MIME tree. An attachment is any
    /// leaf that carries an `attachmentId` or has a non-empty `filename` and
    /// is not a text body part.
    nonisolated static func attachments(of message: GmailMessage) -> [EmailAttachment] {
        var result: [EmailAttachment] = []
        func visit(_ part: GmailMessagePart?) {
            guard let part else { return }
            let isBody = part.mimeType == "text/plain" || part.mimeType == "text/html"
            let hasAttachmentID = part.body?.attachmentId != nil
            if !isBody || hasAttachmentID, let attId = part.body?.attachmentId {
                result.append(EmailAttachment(
                    id: attId,
                    partId: part.partId ?? "",
                    filename: part.filename ?? "attachment",
                    mimeType: part.mimeType ?? "application/octet-stream",
                    size: part.body?.size ?? 0
                ))
            }
            part.parts?.forEach(visit)
        }
        visit(message.payload)
        return result
    }

    /// Conservative HTML→text: drops `script`/`style` wholesale, removes all
    /// remaining tags while letting prose `<` ("a < b") survive, decodes named
    /// and numeric entities, and collapses whitespace. Never renders markup.
    nonisolated static func stripHTML(_ html: String) -> String? {
        var text = html
        for tag in ["script", "style", "head"] {
            if let range = text.range(of: "<\(tag)[\\s\\S]*?</\(tag)>", options: [.regularExpression, .caseInsensitive]) {
                text.replaceSubrange(range, with: " ")
            }
        }
        // Only a `<` that opens a real tag is markup; a prose comparison like
        // "3 < 5" has a space/ digit after the bracket and must survive.
        text = text.replacingOccurrences(of: "<[/!?a-zA-Z][^>]*>", with: " ", options: .regularExpression)
        let entities = [
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
            "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
        ]
        for (entity, replacement) in entities {
            text = text.replacingOccurrences(of: entity, with: replacement)
        }
        text = decodeNumericEntities(text)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Decodes decimal (`&#39;`) and hex (`&#x27;`) character references the
    /// named-entity table above doesn't cover.
    private nonisolated static func decodeNumericEntities(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "&#([xX][0-9a-fA-F]+|[0-9]+);") else { return text }
        var result = ""
        var cursor = text.startIndex
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let wholeRange = Range(match.range, in: text),
                  let digitsRange = Range(match.range(at: 1), in: text) else { continue }
            result += text[cursor..<wholeRange.lowerBound]
            let digits = text[digitsRange]
            let code: UInt32?
            if digits.first == "x" || digits.first == "X" {
                code = UInt32(digits.dropFirst(), radix: 16)
            } else {
                code = UInt32(digits, radix: 10)
            }
            result += code.flatMap(Unicode.Scalar.init).map(String.init) ?? String(text[wholeRange])
            cursor = wholeRange.upperBound
        }
        result += text[cursor...]
        return result
    }
}
