import Foundation

/// One outgoing attachment: bytes plus the metadata MIME needs.
struct OutgoingAttachment: Equatable {
    let filename: String
    let mimeType: String
    let data: Data
}

/// A fully-formed outgoing message before MIME assembly.
struct OutgoingDraft: Equatable {
    var from: String
    var to: String
    var subject: String
    var body: String
    var attachments: [OutgoingAttachment] = []
    /// Set when replying, so Gmail groups the send into the conversation.
    var threadID: String?
    /// Raw `Message-ID` of the message being replied to; emitted as
    /// `In-Reply-To`/`References` so threading survives outside Gmail too.
    var inReplyToMessageID: String?
    var references: [String] = []
}

/// Assembles RFC 5322 messages for `messages.send`.
///
/// SECURITY/ROBUSTNESS MODEL
/// - Pure function: `Data` in, `Data` out, no network, trivially testable.
/// - Headers with non-ASCII content (subject, names) are RFC 2047 B-encoded so
///   we never emit raw 8-bit header bytes.
/// - Attachment bytes are base64 with line-wrapping per RFC 2045 (76 chars),
///   which Gmail's parser requires.
/// - The caller base64url-encodes the finished message once for the API
///   envelope (`GmailSendRequest.raw`).
enum MIMEBuilder {
    enum BuildError: LocalizedError, Equatable {
        case invalidHeader(String)
        case missingReplyMessageID

        var errorDescription: String? {
            switch self {
            case .invalidHeader(let name): return "Cannot send: invalid \(name) header."
            case .missingReplyMessageID: return "Cannot reply: the original message has no valid Message-ID."
            }
        }
    }

    nonisolated static func messageID() -> String {
        "<\(UUID().uuidString.lowercased())@winnow.local>"
    }

    nonisolated static func build(_ draft: OutgoingDraft, messageID: String = MIMEBuilder.messageID(), sentAt: Date = Date()) throws -> Data {
        try validateAddress(draft.from, name: "From")
        try validateAddress(draft.to, name: "To")
        try validateHeader(draft.subject, name: "Subject")
        guard isMessageID(messageID) else { throw BuildError.invalidHeader("Message-ID") }
        let boundary = "=_winnow_\(UUID().uuidString.lowercased())"
        var lines: [String] = []

        lines.append("From: \(draft.from)")
        lines.append("To: \(draft.to)")
        lines.append("Subject: \(encodeHeaderValue(draft.subject))")
        lines.append("Date: \(formatDate(sentAt))")
        lines.append("Message-ID: \(messageID)")
        if let inReplyTo = draft.inReplyToMessageID {
            guard isMessageID(inReplyTo) else { throw BuildError.invalidHeader("In-Reply-To") }
            guard draft.references.allSatisfy(isMessageID) else { throw BuildError.invalidHeader("References") }
            var seen: Set<String> = []
            let references = (draft.references.filter { $0 != inReplyTo } + [inReplyTo]).filter { seen.insert($0).inserted }
            lines.append("In-Reply-To: \(inReplyTo)")
            lines.append("References: \(references.joined(separator: "\r\n "))")
        } else if draft.threadID != nil || !draft.references.isEmpty {
            throw BuildError.missingReplyMessageID
        }
        lines.append("MIME-Version: 1.0")

        if draft.attachments.isEmpty {
            lines.append("Content-Type: text/plain; charset=\"UTF-8\"")
            lines.append("Content-Transfer-Encoding: base64")
            lines.append("")
            lines.append(wrapBase64(Base64URL.plainBase64(Data(draft.body.utf8))))
        } else {
            lines.append("Content-Type: multipart/mixed; boundary=\"\(boundary)\"")
            lines.append("")
            lines.append("--\(boundary)")
            lines.append("Content-Type: text/plain; charset=\"UTF-8\"")
            lines.append("Content-Transfer-Encoding: base64")
            lines.append("")
            lines.append(wrapBase64(Base64URL.plainBase64(Data(draft.body.utf8))))
            for attachment in draft.attachments {
                try validateHeader(attachment.mimeType, name: "Content-Type")
                guard attachment.mimeType.range(of: #"\A[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+\z"#, options: .regularExpression) != nil else {
                    throw BuildError.invalidHeader("Content-Type")
                }
                lines.append("--\(boundary)")
                lines.append("Content-Type: \(attachment.mimeType); name=\"\(sanitizeFilename(attachment.filename))\"")
                lines.append("Content-Disposition: attachment; filename=\"\(sanitizeFilename(attachment.filename))\"")
                lines.append("Content-Transfer-Encoding: base64")
                lines.append("")
                lines.append(wrapBase64(attachment.data.base64EncodedString()))
            }
            lines.append("--\(boundary)--")
        }

        return Data(lines.joined(separator: "\r\n").utf8)
    }

    nonisolated static func validateHeader(_ value: String, name: String) throws {
        guard !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw BuildError.invalidHeader(name)
        }
    }

    nonisolated static func validateAddress(_ value: String, name: String) throws {
        try validateHeader(value, name: name)
        guard value.range(of: #"\A[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\z"#, options: .regularExpression) != nil else {
            throw BuildError.invalidHeader(name)
        }
    }

    nonisolated static func isMessageID(_ value: String) -> Bool {
        guard value.utf8.count <= 900, value.hasPrefix("<"), value.hasSuffix(">") else { return false }
        let inner = value.dropFirst().dropLast()
        let parts = inner.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy { !$0.isEmpty } && inner.unicodeScalars.allSatisfy {
            $0.value > 32 && $0.value < 127 && !"<>\\\"()[]".unicodeScalars.contains($0)
        }
    }

    nonisolated static func messageIDs(in value: String, name: String) throws -> [String] {
        let unfolded = value.replacingOccurrences(of: "\r\n[ \t]+", with: " ", options: .regularExpression)
        guard !unfolded.contains("\r"), !unfolded.contains("\n") else {
            throw BuildError.invalidHeader(name)
        }
        let ids = unfolded.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard ids.allSatisfy(isMessageID) else { throw BuildError.invalidHeader(name) }
        return ids
    }

    // MARK: - Helpers

    /// RFC 2047: non-ASCII header text becomes `=?UTF-8?B?<base64>?=` words.
    /// Each word — including the delimiters — stays within the 75-char
    /// encoded-word limit (strict MTAs mangle overlong ones), splitting on
    /// UTF-8-safe boundaries and joining with CRLF+space, which decoders
    /// ignore between encoded words.
    nonisolated static func encodeHeaderValue(_ value: String) -> String {
        if value.allSatisfy({ $0.isASCII }) { return value }

        let prefix = "=?UTF-8?B?"
        let suffix = "?="
        // RFC 2047 §2: an encoded word must be ≤ 75 chars total.
        let maxEncodedWord = 75
        let maxBase64Chars = maxEncodedWord - prefix.count - suffix.count   // 63
        // base64 emits 4 chars per 3 raw bytes; stay under so padding fits.
        let maxRawBytesPerWord = maxBase64Chars / 4 * 3 - 3                 // 45

        var chunks: [String] = []
        var current = ""
        var currentByteCount = 0
        for scalar in value.unicodeScalars {
            let scalarBytes = UTF8.width(scalar)
            if currentByteCount + scalarBytes > maxRawBytesPerWord {
                chunks.append(current)
                current = ""
                currentByteCount = 0
            }
            current.unicodeScalars.append(scalar)
            currentByteCount += scalarBytes
        }
        if !current.isEmpty { chunks.append(current) }

        return chunks
            .map { prefix + Data(String($0).utf8).base64EncodedString() + suffix }
            .joined(separator: "\r\n ")
    }

    /// RFC 5322 date, e.g. `Sat, 23 Aug 2026 14:03:00 +0100`.
    nonisolated static func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "EEE, d MMM yyyy HH:mm:ss Z"
        return formatter.string(from: date)
    }

    nonisolated static func wrapBase64(_ base64: String) -> String {
        stride(from: 0, to: base64.count, by: 76).map { index in
            let start = base64.index(base64.startIndex, offsetBy: index)
            let end = base64.index(start, offsetBy: min(76, base64.distance(from: start, to: base64.endIndex)))
            return String(base64[start..<end])
        }
        .joined(separator: "\r\n")
    }

    /// Quotes/escapes that could break out of a Content-Disposition filename.
    nonisolated static func sanitizeFilename(_ name: String) -> String {
        String(name.unicodeScalars.filter { $0.value >= 32 && $0.value != 127 })
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: ";", with: "_")
    }
}

extension Base64URL {
    /// Standard padded base64 (for MIME bodies, as opposed to the API's
    /// URL-safe variant).
    nonisolated static func plainBase64(_ data: Data) -> String {
        data.base64EncodedString()
    }
}
