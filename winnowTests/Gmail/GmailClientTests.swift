import Foundation
import Testing
@testable import winnow

@MainActor
struct GmailClientTests {

    private func makeClient() -> (GmailClient, TokenManager, InMemoryTokenStore) {
        let store = InMemoryTokenStore()
        let manager = TokenManager(store: store, credentialsProvider: {
            try GmailCredentials(plistData: try! PropertyListSerialization.data(
                fromPropertyList: ["ClientID": "test-client.apps.googleusercontent.com"],
                format: .xml, options: 0
            ))
        }, session: URLSession(configuration: StubURLProtocol.config))
        manager.adopt(TokenSet(
            accessToken: "good-token",
            refreshToken: "r",
            expiresAt: Date().addingTimeInterval(3600),
            scope: GmailCredentials.scope
        ))
        return (GmailClient(tokenManager: manager, session: URLSession(configuration: StubURLProtocol.config)), manager, store)
    }

    @Test func profileDecodesAndCarriesTheBearerToken() async throws {
        try await StubURLProtocol.exclusive {
            var seenAuth: String?
            StubURLProtocol.route { request in
                seenAuth = request.value(forHTTPHeaderField: "Authorization")
                return (200, Data(#"{"emailAddress":"ada@example.com","historyId":"42","messagesTotal":10}"#.utf8))
            }
            let (client, _, _) = makeClient()
            let profile = try await client.profile()
            #expect(profile.emailAddress == "ada@example.com")
            #expect(profile.historyId == "42")
            #expect(seenAuth == "Bearer good-token")
        }
    }

    @Test func unauthorizedMintsANewTokenAndRetriesOnce() async throws {
        try await StubURLProtocol.exclusive {
            var auths: [String] = []
            StubURLProtocol.route { request in
                if request.url?.host == "oauth2.googleapis.com" {
                    return (200, Data(#"{"access_token":"minted","expires_in":3600,"token_type":"Bearer"}"#.utf8))
                }
                auths.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
                if auths.count == 1 {
                    return (401, Data())
                }
                return (200, Data(#"{"emailAddress":"ada@example.com","historyId":"42"}"#.utf8))
            }
            let (client, _, _) = makeClient()
            let profile = try await client.profile()
            #expect(profile.emailAddress == "ada@example.com")
            #expect(auths == ["Bearer good-token", "Bearer minted"])
            #expect(StubURLProtocol.requestCount(to: "profile") == 2)
        }
    }

    @Test func aSecondUnauthorizedSurfacesAsReauth() async throws {
        try await StubURLProtocol.exclusive {
            StubURLProtocol.route { request in
                if request.url?.host == "oauth2.googleapis.com" {
                    return (400, Data(#"{"error":"invalid_grant"}"#.utf8))
                }
                return (401, Data())
            }
            let (client, _, _) = makeClient()
            await #expect(throws: GmailConfigError.reauthRequired) {
                _ = try await client.profile()
            }
        }
    }

    @Test func httpErrorsCarryStatusAndSnippet() async throws {
        try await StubURLProtocol.exclusive {
            StubURLProtocol.route { _ in (503, Data("backend down".utf8)) }
            let (client, _, _) = makeClient()
            do {
                _ = try await client.profile()
                Issue.record("expected throw")
            } catch let error as GmailAPIError {
                #expect(error == .http(status: 503, bodySnippet: "backend down"))
            }
        }
    }

    @Test func sendWrapsMimeInURLSafeBase64() async throws {
        try await StubURLProtocol.exclusive {
            var decodedMIME: String?
            StubURLProtocol.route { request in
                let body = StubURLProtocol.bodyData(of: request)
                if let json = try? JSONDecoder().decode([String: String].self, from: body),
                   let mime = json["raw"].flatMap(Base64URL.decode) {
                    decodedMIME = String(data: mime, encoding: .utf8)
                }
                return (200, Data(#"{"id":"sent-1","threadId":"t1"}"#.utf8))
            }
            let (client, _, _) = makeClient()
            let mime = MIMEBuilder.build(OutgoingDraft(to: "ada@example.com", subject: "Hi", body: "Hello"))
            let sent = try await client.send(GmailSendRequest(raw: Base64URL.encode(mime), threadId: "t1"))
            #expect(sent.id == "sent-1")
            #expect(decodedMIME?.contains("To: ada@example.com") == true)
        }
    }

    @Test func modifySendsLabelArrays() async throws {
        try await StubURLProtocol.exclusive {
            var captured: GmailModifyRequest?
            StubURLProtocol.route { request in
                captured = try? JSONDecoder().decode(GmailModifyRequest.self, from: StubURLProtocol.bodyData(of: request))
                return (200, Data(#"{"id":"m1","labelIds":["STARRED"]}"#.utf8))
            }
            let (client, _, _) = makeClient()
            let result = try await client.modify(messageID: "m1", addLabelIds: ["STARRED"], removeLabelIds: nil)
            #expect(result.hasLabel(GmailLabel.starred))
            #expect(captured?.addLabelIds == ["STARRED"])
            #expect(captured?.removeLabelIds == nil)
        }
    }
}

@MainActor
struct GmailMapperMIMETests {

    private func messageJSON(_ json: String) throws -> GmailMessage {
        try JSONDecoder().decode(GmailMessage.self, from: Data(json.utf8))
    }

    @Test func mapsARealisticPlainMessage() throws {
        let bodyText = "Want lunch tomorrow?"
        let payload = """
        {
          "id": "m1", "threadId": "t1",
          "labelIds": ["INBOX", "STARRED"],
          "snippet": "Want lunch",
          "internalDate": "1778371140000",
          "payload": {
            "mimeType": "multipart/alternative",
            "headers": [
              {"name": "From", "value": "Ada Lovelace <ada@example.com>"},
              {"name": "Subject", "value": "Lunch?"},
              {"name": "Date", "value": "Sat, 22 Aug 2026 10:00:00 +0000"}
            ],
            "parts": [
              {"mimeType": "text/html", "body": {"data": "\(Base64URL.encode(Data("<b>html</b>".utf8)))"}},
              {"mimeType": "text/plain", "body": {"data": "\(Base64URL.encode(Data(bodyText.utf8)))"}}
            ]
          }
        }
        """
        let email = try GmailMessageMapper.winnowEmail(from: messageJSON(payload))
        #expect(email?.sender == "ada@example.com")
        #expect(email?.name == "Ada Lovelace")
        #expect(email?.subject == "Lunch?")
        #expect(email?.body == bodyText)
        #expect(email?.starred == true)
        #expect(email?.receivedAt == 1_778_371_140_000)
        // Stable numeric id, and stable across calls.
        #expect(email?.id == GmailMessageMapper.stableNumericID(for: "m1"))
    }

    @Test func htmlFallbackIsStrippedToText() throws {
        let html = "<html><style>p{}</style><body><b>Hello</b> &amp; <a href='#'>welcome</a></body></html>"
        let payload = """
        {
          "id": "m2", "labelIds": [],
          "payload": {
            "mimeType": "multipart/alternative",
            "headers": [{"name": "From", "value": "x@y.z"}, {"name": "Subject", "value": "s"}],
            "parts": [{"mimeType": "text/html", "body": {"data": "\(Base64URL.encode(Data(html.utf8)))"}}]
          }
        }
        """
        let email = try GmailMessageMapper.winnowEmail(from: messageJSON(payload))
        #expect(email?.body == "Hello & welcome")
    }

    @Test func trashedMessagesAreMappedWithTheTrashBucket() throws {
        let payload = """
        {"id": "m3", "labelIds": ["TRASH"], "payload": {"headers": [], "mimeType": "text/plain"}}
        """
        let message = try messageJSON(payload)
        // Trash is a first-class mailbox now: the message maps…
        #expect(GmailMessageMapper.winnowEmail(from: message) != nil)
        // …and its bucket comes from the TRASH label.
        #expect(GmailMessageMapper.mailbox(of: message) == .trash)
    }

    @Test func promotionsCategoryBecomesPromotionalType() throws {
        let payload = """
        {"id": "m4", "labelIds": ["CATEGORY_PROMOTIONS"], "payload": {"headers": [{"name":"From","value":"shop@x.io"},{"name":"Subject","value":"Sale"}], "mimeType": "text/plain"}}
        """
        let message = try messageJSON(payload)
        #expect(GmailMessageMapper.winnowEmail(from: message)?.type == "promotional")
    }

    @Test func fromHeaderVariantsAllParse() {
        #expect(GmailMessageMapper.parseFrom(#""Last, First" <f@l.co>"#) == (name: "Last, First", address: "f@l.co"))
        #expect(GmailMessageMapper.parseFrom("Bare <b@r.co>") == (name: "Bare", address: "b@r.co"))
        #expect(GmailMessageMapper.parseFrom("plain@x.co") == (name: nil, address: "plain@x.co"))
        #expect(GmailMessageMapper.parseFrom("") == (name: nil, address: ""))
    }

    @Test func numericIDsAreStableAndDivergent() {
        #expect(GmailMessageMapper.stableNumericID(for: "m1") == GmailMessageMapper.stableNumericID(for: "m1"))
        #expect(GmailMessageMapper.stableNumericID(for: "m1") != GmailMessageMapper.stableNumericID(for: "m2"))
    }

    // MARK: MIME

    @Test func simpleMessageBuildsValidRFC5322() throws {
        let data = MIMEBuilder.build(OutgoingDraft(to: "ada@example.com", subject: "Hello", body: "Body text"))
        let raw = String(data: data, encoding: .utf8) ?? ""
        #expect(raw.contains("To: ada@example.com"))
        #expect(raw.contains("Subject: Hello"))
        #expect(raw.contains("MIME-Version: 1.0"))
        #expect(raw.contains("Message-ID: <"))
        #expect(raw.contains("\r\n\r\n"))
        let bodyPart = raw.components(separatedBy: "\r\n\r\n")[1]
        let decoded = Data(base64Encoded: bodyPart.replacingOccurrences(of: "\r\n", with: ""))
        #expect(String(decoding: decoded ?? Data(), as: UTF8.self) == "Body text")
    }

    @Test func nonASCIISubjectIsRFC2047Encoded() {
        let raw = String(
            decoding: MIMEBuilder.build(OutgoingDraft(to: "a@b.c", subject: "Café ☕", body: "x")),
            as: UTF8.self
        )
        #expect(raw.contains("Subject: =?UTF-8?B?"))
    }

    @Test func attachmentsProduceMultipartMixedWithWrappedBase64() {
        let draft = OutgoingDraft(
            to: "a@b.c",
            subject: "Files",
            body: "See attached",
            attachments: [OutgoingAttachment(filename: "report.pdf", mimeType: "application/pdf", data: Data(repeating: 0xAB, count: 200))]
        )
        let raw = String(decoding: MIMEBuilder.build(draft), as: UTF8.self)
        #expect(raw.contains("multipart/mixed; boundary="))
        #expect(raw.contains("filename=\"report.pdf\""))
        #expect(raw.contains("Content-Disposition: attachment"))
        #expect(raw.contains("Content-Type: application/pdf"))
        // RFC 2045 line length for encoded parts.
        let base64Lines = raw.components(separatedBy: "\r\n").filter { line in
            !line.isEmpty && line.allSatisfy { $0.isLetter || $0.isNumber || "+/=".contains($0) }
        }
        #expect(!base64Lines.isEmpty)
        #expect(base64Lines.allSatisfy { $0.count <= 76 })
    }

    @Test func hostileFilenamesAreSanitized() {
        #expect(MIMEBuilder.sanitizeFilename("evil\".txt\r\nX-Injected: 1") == "evil'.txtX-Injected: 1")
    }
}
