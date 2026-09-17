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

    // MARK: Read state, HTML body, attachments (mailbox features)

    @Test func unreadLabelFlowsIntoTheEmail() throws {
        let message = try Self.decode(#"{"id":"u1","labelIds":["INBOX","UNREAD"],"payload":{"headers":[],"mimeType":"text/plain"}}"#)
        #expect(GmailMessageMapper.winnowEmail(from: message)?.unread == true)
    }

    @Test func noUnreadLabelMeansRead() throws {
        let message = try Self.decode(#"{"id":"u2","labelIds":["INBOX"],"payload":{"headers":[],"mimeType":"text/plain"}}"#)
        #expect(GmailMessageMapper.winnowEmail(from: message)?.unread == false)
    }

    @Test func htmlBodyIsKeptForSandboxedReaderRendering() throws {
        let html = "<p>Hello</p>"
        let payload = """
        {"id":"h1","labelIds":["INBOX"],"payload":{"mimeType":"multipart/alternative","headers":[{"name":"From","value":"a@b.c"}],"parts":[
          {"mimeType":"text/plain","body":{"data":"\(Base64URL.encode(Data("Hello".utf8)))"}},
          {"mimeType":"text/html","body":{"data":"\(Base64URL.encode(Data(html.utf8)))"}}
        ]}}
        """
        let message = try Self.decode(payload)
        let email = try #require(GmailMessageMapper.winnowEmail(from: message))
        #expect(email.body == "Hello")          // reading text…
        #expect(email.bodyHTML == html)         // …source retained for the reader
    }

    @Test func bodyPrefersTheLongestPlainTextLeaf() throws {
        let payload = """
        {"id":"p1","labelIds":["INBOX"],"payload":{"mimeType":"multipart/alternative","headers":[],"parts":[
          {"mimeType":"text/plain","body":{"data":"\(Base64URL.encode(Data("stub".utf8)))"}},
          {"mimeType":"text/plain","body":{"data":"\(Base64URL.encode(Data("Here is the actual, fuller message body.".utf8)))"}}
        ]}}
        """
        let message = try Self.decode(payload)
        #expect(GmailMessageMapper.winnowEmail(from: message)?.body == "Here is the actual, fuller message body.")
    }

    @Test func attachmentsBecomeMetadata() throws {
        let payload = """
        {"id":"a1","labelIds":["INBOX"],"payload":{"mimeType":"multipart/mixed","headers":[],"parts":[
          {"mimeType":"text/plain","body":{"data":"\(Base64URL.encode(Data("body".utf8)))"}},
          {"mimeType":"application/pdf","filename":"invoice.pdf","partId":"1.1","body":{"attachmentId":"att-1","size":1234}}
        ]}}
        """
        let message = try Self.decode(payload)
        let email = try #require(GmailMessageMapper.winnowEmail(from: message))
        #expect(email.attachments.count == 1)
        #expect(email.attachments.first?.filename == "invoice.pdf")
        #expect(email.attachments.first?.mimeType == "application/pdf")
        #expect(email.attachments.first?.size == 1234)
    }

    @Test func mailboxFollowsGmailLabelSemantics() throws {
        let inbox = try Self.decode(#"{"id":"1","labelIds":["INBOX"],"payload":{"headers":[],"mimeType":"text/plain"}}"#)
        #expect(GmailMessageMapper.mailbox(of: inbox) == .inbox)

        // Archive = present but not in Inbox and not in Trash.
        let archived = try Self.decode(#"{"id":"2","labelIds":["STARRED"],"payload":{"headers":[],"mimeType":"text/plain"}}"#)
        #expect(GmailMessageMapper.mailbox(of: archived) == .archive)

        // TRASH dominates even when INBOX is still set.
        let trashed = try Self.decode(#"{"id":"3","labelIds":["INBOX","TRASH"],"payload":{"headers":[],"mimeType":"text/plain"}}"#)
        #expect(GmailMessageMapper.mailbox(of: trashed) == .trash)
    }

    @Test func replyHeadersUseCaseInsensitiveNamesAndUnfoldReferences() throws {
        let message = try Self.decode(#"{"id":"gmail-id","threadId":"gmail-thread","payload":{"headers":[{"name":"mEsSaGe-Id","value":" <parent@example.com> "},{"name":"rEfErEnCeS","value":"<root@example.com>\r\n\t<ancestor@example.com>"}]}}"#)
        let headers = try GmailMessageMapper.replyHeaders(from: message)
        #expect(headers.messageID == "<parent@example.com>")
        #expect(headers.references == ["<root@example.com>", "<ancestor@example.com>"])
    }

    @Test func replyReferencesFallBackToSingleInReplyTo() throws {
        let message = try Self.decode(#"{"id":"m1","payload":{"headers":[{"name":"Message-ID","value":"<parent@example.com>"},{"name":"In-Reply-To","value":"<root@example.com>"}]}}"#)
        #expect(try GmailMessageMapper.replyHeaders(from: message).references == ["<root@example.com>"])
        let multipleParents = try Self.decode(#"{"id":"m1","payload":{"headers":[{"name":"Message-ID","value":"<parent@example.com>"},{"name":"In-Reply-To","value":"<a@example.com> <b@example.com>"}]}}"#)
        #expect(try GmailMessageMapper.replyHeaders(from: multipleParents).references.isEmpty)
    }

    @Test func replyHeadersRejectMissingAmbiguousAndInjectedIDs() throws {
        let missing = try Self.decode(#"{"id":"gmail-id","threadId":"gmail-thread"}"#)
        #expect(throws: MIMEBuilder.BuildError.missingReplyMessageID) { try GmailMessageMapper.replyHeaders(from: missing) }
        let duplicate = try Self.decode(#"{"id":"m1","payload":{"headers":[{"name":"Message-ID","value":"<a@example.com>"},{"name":"Message-ID","value":"<b@example.com>"}]}}"#)
        #expect(throws: MIMEBuilder.BuildError.missingReplyMessageID) { try GmailMessageMapper.replyHeaders(from: duplicate) }
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("References")) {
            try MIMEBuilder.messageIDs(in: "<root@example.com>\r\nBcc: other@example.com", name: "References")
        }
    }

    @Test func referencesRetainAncestorsAndAppendParentOnlyOnce() throws {
        let draft = OutgoingDraft(from: "me@example.com", to: "ada@example.com", subject: "Re: Hi", body: "reply", inReplyToMessageID: "<parent@example.com>", references: ["<root@example.com>", "<root@example.com>", "<parent@example.com>"])
        let raw = String(decoding: try MIMEBuilder.build(draft), as: UTF8.self)
        #expect(raw.contains("In-Reply-To: <parent@example.com>\r\nReferences: <root@example.com>\r\n <parent@example.com>\r\n"))
        var firstReply = draft
        firstReply.references = []
        #expect(String(decoding: try MIMEBuilder.build(firstReply), as: UTF8.self).contains("References: <parent@example.com>\r\n"))
        var newMessage = draft
        newMessage.references = []
        newMessage.inReplyToMessageID = nil
        let fresh = String(decoding: try MIMEBuilder.build(newMessage), as: UTF8.self)
        #expect(!fresh.contains("References:") && !fresh.contains("In-Reply-To:"))
        newMessage.threadID = "gmail-thread"
        #expect(throws: MIMEBuilder.BuildError.missingReplyMessageID) { try MIMEBuilder.build(newMessage) }
    }

    @Test(arguments: ["\r\nBcc: other@example.com", "\nBcc: other@example.com", "\rBcc: other@example.com", "\u{0}"])
    func outgoingHeadersRejectControlCharacters(injection: String) throws {
        let valid = OutgoingDraft(from: "me@example.com", to: "ada@example.com", subject: "Hi", body: "reply")
        var draft = valid
        draft.from += injection
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("From")) { try MIMEBuilder.build(draft) }
        draft = valid
        draft.to += injection
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("To")) { try MIMEBuilder.build(draft) }
        draft = valid
        draft.subject += injection
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("Subject")) { try MIMEBuilder.build(draft) }
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("Message-ID")) { try MIMEBuilder.build(valid, messageID: "<id@example.com>" + injection) }
        draft = valid
        draft.inReplyToMessageID = "<parent@example.com>" + injection
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("In-Reply-To")) { try MIMEBuilder.build(draft) }
        draft.inReplyToMessageID = "<parent@example.com>"
        draft.references = ["<root@example.com>" + injection]
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("References")) { try MIMEBuilder.build(draft) }
        draft = valid
        draft.attachments = [.init(filename: "file.txt", mimeType: "text/plain" + injection, data: Data())]
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("Content-Type")) { try MIMEBuilder.build(draft) }
    }

    @Test(arguments: ["", " ", "not-an-address", "me@example.com,other@example.com"])
    func outgoingSenderMustBeOneAddress(address: String) {
        let draft = OutgoingDraft(from: address, to: "ada@example.com", subject: "Hi", body: "reply")
        #expect(throws: MIMEBuilder.BuildError.invalidHeader("From")) { try MIMEBuilder.build(draft) }
    }

    private static func decode(_ payload: String) throws -> GmailMessage {
        try JSONDecoder().decode(GmailMessage.self, from: Data(payload.utf8))
    }
}
