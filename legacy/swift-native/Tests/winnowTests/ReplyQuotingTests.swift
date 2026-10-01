import Foundation
import Testing
@testable import winnow

/// STO-125: the reply quote is real, editable text in the composer — built by a
/// pure helper so the "insert once, remove only while verbatim-suffixed" rules
/// are provable without a UI.
@MainActor
struct ReplyQuotingTests {

    private func email(
        body: String = "Want to grab lunch at noon?",
        name: String? = nil,
        sender: String = "maya@winnow.app",
        receivedAt: Int = 1_000
    ) -> WinnowEmail {
        Fixtures.email(id: 1, sender: sender, name: name, receivedAt: receivedAt, body: body)
    }

    @Test func attributionUsesTheListTimeFormatterAndDisplayName() {
        let message = email(name: "Maya")
        let line = ReplyQuoting.attributionLine(receivedAtMs: message.receivedAt, displayName: message.displayName)
        // Interpolates through formatListTime — the literal-string bug is gone.
        #expect(line == "On \(formatListTime(message.receivedAt)), Maya wrote:")
        #expect(line.hasSuffix(", Maya wrote:"))
        #expect(line.hasPrefix("On "))
    }

    @Test func quotedBodyPrefixesEveryLineIncludingBlanks() {
        let body = "First line\n\nThird line"
        let quoted = ReplyQuoting.quotedBody(body)
        #expect(quoted == "> First line\n>\n> Third line")
    }

    @Test func blockJoinsAttributionThenQuotedLines() {
        let message = email(body: "Hello\nWorld")
        let block = ReplyQuoting.block(original: message)
        let expected = ReplyQuoting.attributionLine(receivedAtMs: message.receivedAt, displayName: message.displayName)
            + "\n"
            + "> Hello\n> World"
        #expect(block == expected)
    }

    @Test func blockFallsBackToHTMLBodyWhenPlainIsEmpty() {
        var message = email(body: "")
        message.bodyHTML = "<p>html fallback</p>"
        let block = ReplyQuoting.block(original: message)
        #expect(block.hasSuffix("\n> html fallback"))
    }

    @Test func suffixMatchingIsVerbatim() {
        let block = ReplyQuoting.block(original: email())
        // Verbatim suffix: removable.
        #expect(ReplyQuoting.isSuffix(block, of: "My reply\n\n\(block)"))
        // Exactly the block: removable.
        #expect(ReplyQuoting.isSuffix(block, of: block))
        // Edited inside the quote: NOT removable (flag must be kept, text kept).
        #expect(!ReplyQuoting.isSuffix(block, of: "My reply\n\n" + block.replacingOccurrences(of: "wrote:", with: "remarked:")))
        // Truncated: not removable.
        #expect(!ReplyQuoting.isSuffix(block, of: String(block.prefix(block.count - 5))))
        // Empty block never removable.
        #expect(!ReplyQuoting.isSuffix("", of: "anything"))
    }

    @Test func insertionRoundTripsThroughQuotingRules() {
        // The composer flow: build block, append, then allow removal when it
        // still suffixes — the exact sequence toggleQuote performs.
        let message = email()
        let block = ReplyQuoting.block(original: message)
        var reply = "Great idea."
        reply = reply + "\n\n" + block
        #expect(ReplyQuoting.isSuffix(block, of: reply))

        reply.removeSubrange(reply.range(of: block)!)
        reply = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(reply == "Great idea.")
    }
}
