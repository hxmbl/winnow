import Foundation

/// One outgoing attachment: bytes plus the metadata MIME needs.
struct OutgoingAttachment: Equatable {
    let filename: String
    let mimeType: String
    let data: Data
}

/// A fully-formed outgoing message before MIME assembly.
struct OutgoingDraft: Equatable {
    var to: String
    var subject: String
    var body: String
    var attachments: [OutgoingAttachment] = []
    /// Set when replying, so Gmail groups the send into the conversation.
    var threadID: String?
    /// Raw `Message-ID` of the message being replied to; emitted as
    /// `In-Reply-To`/`References` so threading survives outside Gmail too.
    var inReplyToMessageID: String?
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
    nonisolated static func messageID() -> String {
        "<\(UUID().uuidString.lowercased())@winnow.local>"
    }

    nonisolated static func build(_ draft: OutgoingDraft, messageID: String = MIMEBuilder.messageID(), sentAt: Date = Date()) -> Data {
        let boundary = "=_winnow_\(UUID().uuidString.lowercased())"
        var lines: [String] = []

        lines.append("To: \(draft.to)")
        lines.append("Subject: \(encodeHeaderValue(draft.subject))")
        lines.append("Date: \(formatDate(sentAt))")
        lines.append("Message-ID: \(messageID)")
        if let inReplyTo = draft.inReplyToMessageID {
            lines.append("In-Reply-To: \(inReplyTo)")
            lines.append("References: \(inReplyTo)")
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
        name.replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
    }
}

extension Base64URL {
    /// Standard padded base64 (for MIME bodies, as opposed to the API's
    /// URL-safe variant).
    nonisolated static func plainBase64(_ data: Data) -> String {
        data.base64EncodedString()
    }
}
