import Foundation

/// Best-effort syntax highlighting for `<pre><code>` blocks inside email HTML.
///
/// The reader's WKWebView runs with JavaScript disabled
/// (`allowsContentJavaScript = false`), so JS highlighters are impossible. This
/// module re-implements the useful subset in pure Swift: it finds code blocks,
/// guesses a language from the block's class/data attributes, tokenizes the
/// text, and re-emits it wrapped in `wl-*` spans with one injected `<style>`
/// (light + `prefers-color-scheme` dark).
///
/// Robustness rules (email HTML is hostile input):
/// - Only `<pre …><code …>` blocks are touched; inline `<code>` is left alone.
/// - A block whose content contains a **literal** `<` is left untouched (nested
///   markup or malformed HTML) rather than mangled. Escaped form (`&lt;`) is
///   decoded, tokenized, and re-escaped, so generics like `Array&lt;T&gt;`
///   still highlight.
/// - All code text is HTML-escaped on output and spans never carry user content
///   in attributes, so there is no injection surface.
struct CodeHighlighting {

    struct Token: Equatable {
        enum Kind: String, Equatable {
            case plain, keyword, type, function, string, number, comment
        }

        let kind: Kind
        let text: String
    }

    /// Returns `html` with every clean `<pre><code>` block highlighted. Blocks
    /// that fail the safety checks and documents with nothing to highlight are
    /// returned untouched (byte-for-byte if nothing matched).
    static func highlightCodeBlocks(in html: String) -> String {
        var result = ""
        var index = html.startIndex
        var highlightedAny = false

        while let preStart = html.range(of: "<pre", options: [.caseInsensitive], range: index..<html.endIndex) {
            result += html[index..<preStart.lowerBound]
            guard let preTagEnd = html.range(of: ">", range: preStart.lowerBound..<html.endIndex),
                  let closeTag = html.range(of: "</pre>", options: [.caseInsensitive], range: preTagEnd.upperBound..<html.endIndex) else {
                // Unfinished pre at the tail — append the remainder as-is.
                result += html[preStart.lowerBound..<html.endIndex]
                index = html.endIndex
                break
            }

            let bodyRange = preTagEnd.upperBound..<closeTag.lowerBound
            let openTags = html[preStart.lowerBound..<preTagEnd.upperBound]

            var replacement: String?
            if let codeStart = html.range(of: "<code", options: [.caseInsensitive], range: bodyRange),
               codeStart.upperBound < closeTag.lowerBound,
               Self.isTagEdge(html[codeStart.upperBound]) {
                if let codeTagEnd = html.range(of: ">", range: codeStart.lowerBound..<closeTag.lowerBound),
                   let rawEnd = html.range(of: "</code", options: [.caseInsensitive], range: codeTagEnd.upperBound..<closeTag.lowerBound) {
                    let codeTag = html[codeStart.lowerBound..<codeTagEnd.upperBound]
                    let rawCode = html[codeTagEnd.upperBound..<rawEnd.lowerBound]
                    replacement = Self.highlightedBlock(
                        openTags: String(openTags),
                        codeTag: String(codeTag),
                        rawCode: String(rawCode),
                        language: Self.language(fromTag: String(codeTag))
                    )
                }
            }

            if let replacement {
                highlightedAny = true
                result += replacement
            } else {
                result += html[preStart.lowerBound..<closeTag.upperBound]
            }
            index = closeTag.upperBound
        }

        result += html[index..<html.endIndex]
        guard highlightedAny else { return result }
        return styleCSS + result
    }

    /// Wraps clean code text in spans. `rawCode` is the text between `<code>` and
    /// `</code>` exactly as authored — escaped entities and all. The original
    /// `<pre>`/`<code>` open tags are kept verbatim so nothing else changes.
    private static func highlightedBlock(openTags: String, codeTag: String, rawCode: String, language: String?) -> String? {
        // A literal '<' means nested markup (or broken escaping). Don't touch
        // the block rather than risk mangling it. Escaped "&lt;" is safe.
        guard !rawCode.contains("<") else { return nil }
        let decoded = decodeEntities(rawCode)
        let highlighted = highlightedHTML(for: decoded, language: language)
        return openTags + codeTag + highlighted + "</code></pre>"
    }

    /// Escapes `code` (already plain text) into span-wrapped HTML.
    static func highlightedHTML(for code: String, language: String?) -> String {
        var out = ""
        out.reserveCapacity(code.count)
        for token in tokens(in: code, language: language) {
            let escaped = escapeHTML(token.text)
            switch token.kind {
            case .plain: out += escaped
            case .keyword: out += span("wl-keyword", escaped)
            case .type: out += span("wl-type", escaped)
            case .function: out += span("wl-function", escaped)
            case .string: out += span("wl-string", escaped)
            case .number: out += span("wl-number", escaped)
            case .comment: out += span("wl-comment", escaped)
            }
        }
        return out
    }

    /// One-pass tokenizer. Pure and deterministic so tests can snapshot it.
    static func tokens(in code: String, language: String?) -> [Token] {
        let keywords = keywordSet(for: language)
        let types = typeSet(for: language)
        let camelCaseTypes = language == "swift" || language == "cpp" || language == "java" || language == "kotlin" || language == "csharp" || language == "rust"

        var result: [Token] = []
        var i = code.startIndex

        while i < code.endIndex {
            let c = code[i]

            // Line / block comments.
            if c == "/", let n = code.index(i, offsetBy: 1, limitedBy: code.endIndex), n < code.endIndex, code[n] == "/" {
                var end = n
                while end < code.endIndex, code[end] != "\n" { end = code.index(after: end) }
                result.append(Token(kind: .comment, text: String(code[i..<end])))
                i = end
                continue
            }
            if c == "/", let n = code.index(i, offsetBy: 1, limitedBy: code.endIndex), n < code.endIndex, code[n] == "*" {
                var end = n
                while end < code.endIndex {
                    let after = code.index(after: end)
                    if after < code.endIndex, code[end] == "*" && code[after] == "/" {
                        end = code.index(after: after)
                        break
                    }
                    end = after
                }
                result.append(Token(kind: .comment, text: String(code[i..<end])))
                i = end
                continue
            }
            if c == "#", isHashCommentLanguage(language) {
                var end = i
                while end < code.endIndex, code[end] != "\n" { end = code.index(after: end) }
                result.append(Token(kind: .comment, text: String(code[i..<end])))
                i = end
                continue
            }
            if c == "-" && language == "sql", let n = code.index(i, offsetBy: 1, limitedBy: code.endIndex), n < code.endIndex, code[n] == "-" {
                var end = n
                while end < code.endIndex, code[end] != "\n" { end = code.index(after: end) }
                result.append(Token(kind: .comment, text: String(code[i..<end])))
                i = end
                continue
            }

            // Strings: "…", '…', `…`, plus triple-quoted variants.
            if c == "\"" || c == "'" || c == "`" {
                let quote = c
                var end = i
                var triple = false
                if let n = code.index(i, offsetBy: 1, limitedBy: code.endIndex),
                   let nn = code.index(i, offsetBy: 2, limitedBy: code.endIndex),
                   nn < code.endIndex, code[n] == quote, code[nn] == quote {
                    triple = true
                    end = code.index(after: nn)
                } else {
                    end = code.index(after: i)
                }
                while end < code.endIndex {
                    let ch = code[end]
                    if ch == "\\", let n = code.index(end, offsetBy: 1, limitedBy: code.endIndex), n < code.endIndex {
                        end = code.index(after: n)
                        continue
                    }
                    if ch == quote {
                        if triple {
                            if let n = code.index(end, offsetBy: 1, limitedBy: code.endIndex), n < code.endIndex,
                               let nn = code.index(end, offsetBy: 2, limitedBy: code.endIndex), nn < code.endIndex,
                               code[n] == quote, code[nn] == quote {
                                end = code.index(after: nn)
                                break
                            }
                        } else {
                            end = code.index(after: end)
                            break
                        }
                    }
                    end = code.index(after: end)
                }
                result.append(Token(kind: .string, text: String(code[i..<end])))
                i = end
                continue
            }

            // Numbers (incl. 0x hex and 1_000 separators).
            if c.isASCII && c.isNumber || (c == "." && nextIsDigit(in: code, at: i)) {
                var end = i
                while end < code.endIndex, Self.isNumberChar(code[end]) { end = code.index(after: end) }
                result.append(Token(kind: .number, text: String(code[i..<end])))
                i = end
                continue
            }

            // Identifiers → classify.
            if Self.isIdentifierStart(c) {
                var end = i
                while end < code.endIndex, Self.isIdentifierChar(code[end]) { end = code.index(after: end) }
                var token = String(code[i..<end])
                // Strip a spelling-dependent @ prefix (Swift/SwiftUI attribute).
                let kind: Token.Kind
                if token.first == "@" {
                    token.removeFirst()
                    kind = keywords.contains(token) ? .keyword : .plain
                } else if keywords.contains(token) {
                    kind = .keyword
                } else if types.contains(token) || (camelCaseTypes && token.first?.isUppercase == true) {
                    kind = .type
                } else if isFunctionCall(in: code, after: end) {
                    kind = .function
                } else {
                    kind = .plain
                }
                result.append(Token(kind: kind, text: String(code[i..<end])))
                i = end
                continue
            }

            // Any other single character is plain text.
            result.append(Token(kind: .plain, text: String(c)))
            i = code.index(after: i)
        }
        return result
    }

    // MARK: - Tokenizer helpers

    private static func nextIsDigit(in code: String, at index: String.Index) -> Bool {
        guard let n = code.index(index, offsetBy: 1, limitedBy: code.endIndex), n < code.endIndex else { return false }
        return code[n].isASCII && code[n].isNumber
    }

    private static func isHashCommentLanguage(_ language: String?) -> Bool {
        language == "shell" || language == "python" || language == "yaml" || language == "ruby"
    }

    private static func isNumberChar(_ c: Character) -> Bool {
        (c.isASCII && (c.isNumber || c == "_" || c == ".")) || ["x", "X", "a", "b", "c", "d", "e", "f", "A", "B", "C", "D", "E", "F"].contains(c)
    }

    private static func isFunctionCall(in code: String, after index: String.Index) -> Bool {
        var scan = index
        while scan < code.endIndex, code[scan].isWhitespace { scan = code.index(after: scan) }
        return scan < code.endIndex && code[scan] == "("
    }

    private static func isIdentifierStart(_ c: Character) -> Bool {
        c.isLetter || c == "_" || c == "@"
    }

    private static func isIdentifierChar(_ c: Character) -> Bool {
        c.isLetter || (c.isASCII && c.isNumber) || c == "_"
    }

    private static func isTagEdge(_ c: Character) -> Bool {
        c == " " || c == ">" || c == "/" || c == "\n" || c == "\t" || c == "\r"
    }

    // MARK: - Language detection

    /// Reads a language off `<code …>`, mirroring Prism/GitHub's conventions:
    /// `class="language-swift"`, `class="lang-swift"`, `data-lang="swift"`.
    private static func language(fromTag tag: String) -> String? {
        let lower = tag.lowercased()
        var name: String?
        // class="language-swift" / class='lang-swift' (single- or double-quoted).
        for needle in ["language-", "lang-"] {
            for quote in ["\"", "'"] {
                if let range = lower.range(of: "class=\(quote)\(needle)") {
                    name = String(lower[range.upperBound...])
                    break
                }
            }
            if name != nil { break }
        }
        // data-lang="swift" / data-lang='swift' — only when no class language.
        if name == nil, let range = lower.range(of: "data-lang") {
            var value = lower[range.upperBound...]
            while let first = value.first, first == "=" || first == "\"" || first == "'" || first.isWhitespace {
                value = value.dropFirst()
            }
            name = String(value.prefix { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "#" })
        }
        guard let raw = name?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let cleaned = raw.prefix { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "#" }
        return alias(String(cleaned))
    }

    private static func alias(_ raw: String) -> String? {
        switch raw {
        case "js", "jsx", "javascript", "node", "nodejs": return "javascript"
        case "py", "python": return "python"
        case "sh", "bash", "zsh", "shell", "console", "terminal": return "shell"
        case "ts", "typescript": return "typescript"
        case "rs", "rust": return "rust"
        case "kt", "kotlin": return "kotlin"
        case "rb", "ruby": return "ruby"
        case "cpp", "c++", "cc", "cxx", "h", "hpp": return "cpp"
        case "cs", "csharp": return "csharp"
        case "java": return "java"
        case "go", "golang": return "go"
        case "htm", "html", "xml", "svg", "markup": return "markup"
        case "md", "markdown": return "markdown"
        case "yml", "yaml": return "yaml"
        case "json": return "json"
        case "swift": return "swift"
        case "sql": return "sql"
        default: return raw
        }
    }

    // MARK: - Keyword / type tables

    nonisolated private static let swiftKeywords: Set<String> = [
        "class", "struct", "enum", "func", "let", "var", "if", "else", "elseif", "guard", "for", "in", "while",
        "repeat", "return", "throw", "throws", "try", "catch", "switch", "case", "default", "break", "continue",
        "import", "extension", "protocol", "inout", "init", "deinit", "self", "super", "nil", "true", "false",
        "where", "defer", "async", "await", "actor", "some", "any", "public", "private", "internal", "fileprivate",
        "open", "static", "final", "lazy", "override", "mutating", "nonisolated", "is", "as", "rethrows",
        "associatedtype", "typealias", "indirect", "infix", "prefix", "postfix", "operator", "precedencegroup",
        "convenience", "required", "dynamic", "noescape", "escaping", "optional", "weak", "unowned", "frozen",
    ]

    nonisolated private static let swiftTypes: Set<String> = [
        "String", "Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32", "UInt64",
        "Double", "Float", "Bool", "Character", "Array", "Dictionary", "Set", "Optional", "Result", "Error",
        "UUID", "URL", "Date", "Data", "CGFloat", "CGPoint", "CGSize", "CGRect", "NSView", "NSWindow", "NSEvent",
        "WKWebView", "Color", "Font", "Task", "Any", "Hashable", "Equatable", "Codable", "Identifiable", "Sendable",
        "NSObject", "StringProtocol", "Substring", "Sequence", "Collection",
    ]

    nonisolated private static let javascriptKeywords: Set<String> = [
        "function", "var", "let", "const", "if", "else", "for", "while", "do", "return", "new", "class", "extends",
        "super", "import", "export", "default", "async", "await", "try", "catch", "finally", "throw", "switch",
        "case", "break", "continue", "typeof", "instanceof", "in", "of", "this", "null", "undefined", "true",
        "false", "delete", "void", "yield", "static", "get", "set", "from", "as", "interface", "type", "enum",
        "implements", "private", "public", "protected", "readonly",
    ]

    nonisolated private static let pythonKeywords: Set<String> = [
        "def", "class", "if", "elif", "else", "for", "while", "return", "import", "from", "as", "with", "try",
        "except", "finally", "raise", "lambda", "global", "nonlocal", "pass", "break", "continue", "del", "yield",
        "async", "await", "True", "False", "None", "in", "not", "and", "or", "is", "assert", "match", "case",
        "self", "type", "async",
    ]

    nonisolated private static let pythonTypes: Set<String> = [
        "int", "str", "float", "bool", "list", "dict", "set", "tuple", "bytes", "NoneType", "object", "range",
        "type", "Exception", "ValueError", "TypeError", "RuntimeError",
    ]

    nonisolated private static let shellKeywords: Set<String> = [
        "if", "then", "elif", "else", "fi", "for", "in", "do", "while", "until", "case", "esac", "function",
        "return", "exit", "echo", "cd", "export", "local", "readonly", "shift", "source", "true", "false", "set",
        "unset", "select", "break", "continue",
    ]

    nonisolated private static let sqlKeywords: Set<String> = [
        "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table",
        "alter", "drop", "join", "left", "right", "inner", "outer", "full", "cross", "on", "group", "by", "order",
        "having", "limit", "offset", "union", "all", "distinct", "as", "and", "or", "not", "null", "is", "like",
        "in", "exists", "primary", "key", "foreign", "references", "index", "view", "count", "sum", "avg", "min",
        "max", "begin", "commit", "rollback", "case", "when", "then", "else", "end", "explain", "show", "with",
    ]

    nonisolated private static let typescriptKeyords: Set<String> = [
        "interface", "type", "enum", "namespace", "declare", "abstract", "implements", "readonly", "const",
        "let", "var", "function", "return", "class", "extends", "implements", "public", "private", "protected",
        "static", "async", "await", "export", "import", "from", "default", "new", "this", "null", "undefined",
        "true", "false", "if", "else", "for", "while", "switch", "case", "break", "continue", "try", "catch",
        "finally", "throw", "typeof", "instanceof", "in", "of", "yield", "readonly", "abstract", "any", "never",
        "unknown", "void", "as",
    ]

    nonisolated private static let goKeywords: Set<String> = [
        "func", "package", "import", "var", "const", "type", "struct", "interface", "map", "chan", "defer",
        "go", "range", "if", "else", "for", "switch", "case", "default", "return", "break", "continue", "fallthrough",
        "select", "go", "goto", "nil", "true", "false", "iota",
    ]

    nonisolated private static let rustKeywords: Set<String> = [
        "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "mod", "use", "crate", "pub",
        "fn", "if", "else", "match", "loop", "while", "for", "return", "break", "continue", "move", "ref", "async",
        "await", "dyn", "where", "type", "self", "super", "true", "false", "unsafe",
    ]

    nonisolated private static let genericKeywords: Set<String> = {
        var all = swiftKeywords
        all.formUnion(javascriptKeywords)
        all.formUnion(pythonKeywords)
        all.formUnion(shellKeywords)
        all.formUnion(sqlKeywords)
        all.formUnion(typescriptKeyords)
        all.formUnion(goKeywords)
        all.formUnion(rustKeywords)
        return all
    }()

    nonisolated private static let genericTypes: Set<String> = {
        var all = swiftTypes
        all.formUnion(pythonTypes)
        return all
    }()

    private static func keywordSet(for language: String?) -> Set<String> {
        switch language {
        case "swift": return swiftKeywords
        case "javascript", "typescript": return language == "typescript" ? typescriptKeyords : javascriptKeywords
        case "python": return pythonKeywords
        case "shell", "bash", "zsh": return shellKeywords
        case "sql": return sqlKeywords
        case "go": return goKeywords
        case "rust": return rustKeywords
        default: return genericKeywords
        }
    }

    private static func typeSet(for language: String?) -> Set<String> {
        switch language {
        case "swift": return swiftTypes
        case "python": return pythonTypes
        default: return genericTypes
        }
    }

    // MARK: - Output

    /// Escapes text for safe inclusion in HTML. All code text goes through this
    /// before being placed in a span.
    static func escapeHTML(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }

    private static func span(_ className: String, _ escaped: String) -> String {
        "<span class=\"\(className)\">\(escaped)</span>"
    }

    /// Decodes the entity subset emails actually use inside code blocks.
    /// `&amp;` is decoded last so a double-escaped pair like `&amp;lt;` reads
    /// back as `&lt;` rather than a bare `<`.
    private static func decodeEntities(_ text: String) -> String {
        text.replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    /// Injected before the document once any block was highlighted. Targets
    /// only the `wl-*` spans, so an email's own styling is never touched.
    nonisolated private static let styleCSS = """
    <style>
    pre code .wl-keyword{color:#7c3aed;font-weight:600}
    pre code .wl-type{color:#087a94}
    pre code .wl-function{color:#c2410c}
    pre code .wl-string{color:#b3353c}
    pre code .wl-number{color:#6a737d}
    pre code .wl-comment{color:#8a8f98;font-style:italic}
    @media (prefers-color-scheme: dark) {
      pre code .wl-keyword{color:#c9a6ff}
      pre code .wl-type{color:#4cc9f0}
      pre code .wl-function{color:#ff9e64}
      pre code .wl-string{color:#f28f8d}
      pre code .wl-number{color:#a3a8b0}
      pre code .wl-comment{color:#777c85;font-style:italic}
    }
    </style>
    """
}