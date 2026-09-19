import Foundation
import Testing
@testable import winnow

struct CodeHighlightingTests {

    // MARK: - Safety guards

    @Test func documentsWithoutCodeBlocksAreReturnedUnchanged() {
        let html = "<p>Hello</p><div>world</div>"
        #expect(CodeHighlighting.highlightCodeBlocks(in: html) == html)
    }

    @Test func inlineCodeWithoutAPreIsLeftAlone() {
        let html = "<p>Use <code>stack.push()</code> here.</p>"
        #expect(CodeHighlighting.highlightCodeBlocks(in: html) == html)
    }

    @Test func blocksContainingLiteralAngleBracketsAreSkippedNotMangled() {
        // A literal '<' inside the block means nested markup (or malformed
        // HTML) — leave the whole block byte-for-byte untouched.
        let src = "<pre><code><b>bold nested</b></code></pre>"
        #expect(CodeHighlighting.highlightCodeBlocks(in: src) == src)
    }

    @Test func escapedAngleBracketsAreDecodedTokenizedAndRoundTripped() {
        let src = "<pre><code class=\"language-swift\">let stack = Array&lt;Int&gt;()</code></pre>"
        let out = CodeHighlighting.highlightCodeBlocks(in: src)

        // The original open tags are preserved exactly.
        #expect(out.contains("<pre><code class=\"language-swift\">"))
        // Swift's CamelCase types classify as types.
        #expect(out.contains("<span class=\"wl-type\">Array</span>&lt;<span class=\"wl-type\">Int</span>&gt;"))
        #expect(out.contains("<span class=\"wl-keyword\">let</span>"))
        // The escaped comparison/generic text survives intact.
        #expect(out.contains("Array</span>&lt;"))
    }

    // MARK: - Highlighting output

    @Test func keywordsAndStringsAreWrappedAndEscaped() {
        let html = CodeHighlighting.highlightedHTML(for: "let greeting = \"hi\"", language: "swift")
        #expect(html.contains("wl-keyword\">let</span>"))
        #expect(html.contains("wl-string\">&quot;hi&quot;</span>"))
        #expect(html.contains("&quot;hi&quot;"))
    }

    @Test func styleIsInjectedOnceAcrossManyBlocks() {
        let src = """
        <pre><code class="language-swift">let a = 1</code></pre>
        <pre><code class="language-swift">let b = 2</code></pre>
        """
        let out = CodeHighlighting.highlightCodeBlocks(in: src)
        let styleCount = out.components(separatedBy: "<style").count - 1
        #expect(styleCount == 1)
        #expect(out.contains(".wl-keyword"))
    }

    @Test func blocksWithoutALanguageClassStillHighlightWithTheGenericTable() {
        let src = "<pre><code>if (x &lt; 3) return</code></pre>"
        let out = CodeHighlighting.highlightCodeBlocks(in: src)
        #expect(out.contains("wl-keyword\">if</span>"))
        #expect(out.contains("wl-keyword\">return</span>"))
        #expect(out.contains("wl-number\">3</span>"))
    }

    @Test func dataLangAttributeSelectsTheRightLanguage() {
        let src = "<pre><code data-lang=\"python\"># note\nprint(\"hi\")</code></pre>"
        let out = CodeHighlighting.highlightCodeBlocks(in: src)
        #expect(out.contains("wl-comment\"># note</span>"))
        #expect(out.contains("wl-string\">&quot;hi&quot;</span>"))
    }

    @Test func preservingOriginalOpenTagsKeepsBlockStyling() {
        let src = "<pre style=\"background:#f5f5f5\"><code class=\"language-swift\">let x = 1</code></pre>"
        let out = CodeHighlighting.highlightCodeBlocks(in: src)
        #expect(out.contains("<pre style=\"background:#f5f5f5\"><code class=\"language-swift\">"))
        #expect(out.contains("wl-keyword\">let</span>"))
        #expect(out.hasSuffix("</code></pre>"))
    }

    // MARK: - Tokenizer

    @Test func tokensClassifyCommentsKeywordsNumbersAndCalls() {
        let tokens = CodeHighlighting.tokens(in: "// intro\nlet count = 42\ndoubler(x)", language: "swift")

        func kinds() -> [(CodeHighlighting.Token.Kind, String)] {
            tokens.map { ($0.kind, $0.text) }
        }

        let mapped = kinds()
        #expect(mapped[0] == (.comment, "// intro"))
        #expect(mapped.contains { $0 == (.keyword, "let") })
        #expect(mapped.contains { $0 == (.number, "42") })
        // Followed by '(' → a call site.
        #expect(mapped.contains { $0 == (.function, "doubler") })
    }

    @Test func hashCommentsDependOnLanguage() {
        let python = CodeHighlighting.tokens(in: "# setup\nx = 1", language: "python")
        #expect(python.first?.kind == .comment)
        #expect(python.first?.text == "# setup")

        let swift = CodeHighlighting.tokens(in: "# not a comment", language: "swift")
        #expect(swift.contains { $0.kind == .comment } == false)
    }

    @Test func tripleQuotedStringsAndEscapesStayInsideOneToken() {
        let tokens = CodeHighlighting.tokens(in: "\"a \\\" b\"", language: "swift")
        #expect(tokens.count == 1)
        #expect(tokens[0].kind == .string)
        #expect(tokens[0].text == "\"a \\\" b\"")

        let triple = CodeHighlighting.tokens(in: "let x = \"\"\"\nline\n\"\"\"", language: "swift")
        #expect(triple.contains { $0.kind == .string && $0.text.contains("line") })
    }

    // MARK: - Escaping

    @Test func escapeWrapsAllFiveSpecialCharacters() {
        #expect(CodeHighlighting.escapeHTML("&<>\"'") == "&amp;&lt;&gt;&quot;&#39;")
        #expect(CodeHighlighting.escapeHTML("plain") == "plain")
    }
}