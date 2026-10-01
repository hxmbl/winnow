import Foundation

// Codable mirrors of the Gmail REST API responses we consume.
// Every field that can be absent in a real payload is Optional — history
// records and list stubs carry partial messages, and a decode crash on a
// partial payload would take down sync.

/// `GET /users/me/profile`
struct GmailProfile: Codable, Equatable {
    let emailAddress: String
    let historyId: String
    let messagesTotal: Int?
}

/// One entry of `messages.list` — an id pair only.
struct GmailMessageStub: Codable, Equatable {
    let id: String
    let threadId: String
}

/// `GET /users/me/messages` (and `threads`-adjacent list shapes)
struct GmailMessageList: Codable, Equatable {
    let messages: [GmailMessageStub]?
    let nextPageToken: String?
    let resultSizeEstimate: Int?
}

/// A single RFC 2822 header line.
struct GmailHeader: Codable, Equatable {
    let name: String
    let value: String
}

/// A MIME part body. `data` is present for inline parts (URL-safe base64),
/// `attachmentId` for attachments (fetched separately — M1 ignores them).
struct GmailPartBody: Codable, Equatable {
    let size: Int?
    let data: String?
    let attachmentId: String?
}

/// A node of Gmail's flattened MIME tree.
struct GmailMessagePart: Codable, Equatable {
    let partId: String?
    let mimeType: String?
    let filename: String?
    let headers: [GmailHeader]?
    let body: GmailPartBody?
    let parts: [GmailMessagePart]?
}

/// `GET /users/me/messages/{id}?format=full`
struct GmailMessage: Codable, Equatable {
    let id: String
    let threadId: String?
    let labelIds: [String]?
    let snippet: String?
    /// Milliseconds since epoch, as a *string* per the API.
    let internalDate: String?
    let payload: GmailMessagePart?

    nonisolated func hasLabel(_ label: String) -> Bool {
        labelIds?.contains(label) ?? false
    }
}

/// `POST /users/me/messages/{id}/modify`
struct GmailModifyRequest: Codable, Equatable {
    let addLabelIds: [String]?
    let removeLabelIds: [String]?
}

/// `POST /users/me/messages/send`
struct GmailSendRequest: Codable, Equatable {
    /// Full RFC 2822 message, URL-safe base64 encoded.
    let raw: String
    let threadId: String?
}

/// `GET /users/me/history?startHistoryId=…`
struct GmailHistoryList: Codable, Equatable {
    let history: [GmailHistoryRecord]?
    let historyId: String
    let nextPageToken: String?
}

struct GmailHistoryRecord: Codable, Equatable {
    let id: String?
    let messagesAdded: [GmailMessageWrapper]?
    let messagesDeleted: [GmailMessageWrapper]?
    let labelsAdded: [GmailLabelChange]?
    let labelsRemoved: [GmailLabelChange]?
}

struct GmailMessageWrapper: Codable, Equatable {
    let message: GmailMessage
}

struct GmailLabelChange: Codable, Equatable {
    let message: GmailLabelChangeMessage
}

struct GmailLabelChangeMessage: Codable, Equatable {
    let id: String
    let labelIds: [String]?
}

/// `GET /users/me/messages/{id}/attachments/{attachmentId}`
struct GmailAttachment: Codable, Equatable {
    let size: Int?
    let data: String?
}

/// Gmail's labels that Winnow consumes. Everything else is ignored — the
/// mapping layer treats unknown labels as noise rather than failing.
enum GmailLabel {
    nonisolated static let starred = "STARRED"
    nonisolated static let trash = "TRASH"
    nonisolated static let inbox = "INBOX"
    nonisolated static let unread = "UNREAD"
    nonisolated static let spam = "SPAM"
    nonisolated static let categoryPromotions = "CATEGORY_PROMOTIONS"
}

/// Gmail encodes payloads as **URL-safe base64 without padding**. These two
/// helpers are the only place that convention is handled.
enum Base64URL {
    nonisolated static func decode(_ value: String) -> Data? {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder > 0 { normalized.append(String(repeating: "=", count: 4 - remainder)) }
        return Data(base64Encoded: normalized)
    }

    nonisolated static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
