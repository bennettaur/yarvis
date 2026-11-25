import Testing
@testable import YarvisClient

private func kinds(_ code: String, _ language: String) -> [[String]] {
    let lines = splitAll(code)
    let spans = highlightLines(code, language: language) ?? []
    return zip(lines, spans).map { line, spans in
        let units = Array(line.utf16)
        return spans.map { span in
            let text = String(utf16CodeUnits: Array(units[span.start..<(span.start + span.length)]), count: span.length)
            return "\(span.kind):\(text)"
        }
    }
}

private func splitAll(_ code: String) -> [String] {
    code.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
}

@Suite struct SyntaxHighlightTests {
    @Test func languageByFilenameThenExtension() {
        #expect(languageForPath("src/app/main.ts") == "typescript")
        #expect(languageForPath("a/B.TSX") == "typescript")
        #expect(languageForPath("Dockerfile") == "dockerfile")
        #expect(languageForPath("x/Gemfile") == "ruby")
        #expect(languageForPath("config.toml") == "ini")
        #expect(languageForPath("README") == nil)
        #expect(languageForPath(".gitignore") == nil)
        #expect(languageForPath("weird.zzz") == nil)
    }

    @Test func unknownLanguageIsNil() {
        #expect(highlightLines("x", language: "cobol") == nil)
    }

    @Test func colouresKeywordsStringsNumbersAndComments() {
        let out = kinds("const x = \"hi\" + 42 // note", "typescript")
        #expect(out == [["keyword:const", "string:\"hi\"", "number:42", "comment:// note"]])
    }

    @Test func blockCommentSpansLines() {
        let out = kinds("a /* one\ntwo */ return", "javascript")
        #expect(out == [["comment:/* one"], ["comment:two */", "keyword:return"]])
    }

    @Test func singleLineStringStopsAtLineEnd() {
        let out = kinds("x = \"open\nlet y", "swift")
        #expect(out == [["string:\"open"], ["keyword:let"]])
    }

    @Test func tripleQuotedStringSpansLines() {
        let out = kinds("s = \"\"\"a\nb\"\"\"\nif", "python")
        #expect(out == [["string:\"\"\"a"], ["string:b\"\"\""], ["keyword:if"]])
    }

    @Test func templateLiteralSpansLines() {
        let out = kinds("`a\nb` in", "typescript")
        #expect(out == [["string:`a"], ["string:b`", "keyword:in"]])
    }

    @Test func escapedQuoteStaysInString() {
        let out = kinds(#"x = "a\"b" if"#, "python")
        #expect(out == [[#"string:"a\"b""#, "keyword:if"]])
    }

    @Test func rustLifetimeIsNotAString() {
        let out = kinds("fn f<'a>(x: &'a str) -> Self", "rust")
        #expect(out.first?.contains("keyword:fn") == true)
        #expect(out.first?.contains { $0.hasPrefix("string:") } == false)
    }

    @Test func capitalisedNamesAreTypes() {
        #expect(kinds("let m: Map = nil", "swift") == [["keyword:let", "type:Map", "literal:nil"]])
    }

    @Test func sqlKeywordsIgnoreCase() {
        #expect(kinds("SELECT a FROM t -- x", "sql") == [["keyword:SELECT", "keyword:FROM", "comment:-- x"]])
    }

    @Test func yamlKeysAndComments() {
        #expect(kinds("name: x # c\nok: true", "yaml") == [["keyword:name", "comment:# c"], ["keyword:ok", "literal:true"]])
    }

    @Test func xmlTagNames() {
        #expect(kinds("<div class=\"a\"></div>", "xml") == [["keyword:div", "string:\"a\"", "keyword:div"]])
    }

    @Test func numbersInsideIdentifiersAreNot() {
        #expect(kinds("x2 = 3", "python") == [["number:3"]])
    }

    @Test func spansUseUTF16Offsets() {
        let spans = highlightLines("é = \"x\"", language: "python")
        #expect(spans == [[SyntaxSpan(start: 4, length: 3, kind: .string)]])
    }

    @Test func oneSpanListPerLine() {
        #expect(highlightLines("a\n\nb\n", language: "go")?.count == 4)
    }

    @Test func tooLargeIsNil() {
        #expect(highlightLines(String(repeating: "x", count: maxHighlightLineLength + 1), language: "go") == nil)
        #expect(highlightLines(String(repeating: "x\n", count: maxHighlightLines + 1), language: "go") == nil)
        #expect(highlightLines(String(repeating: "x", count: 10), language: "go") != nil)
    }
}

@Suite struct MarkdownHighlightTests {
    @Test func singleBacktickStaysOnItsLine() {
        let spans = highlightLines("a `code\nb", language: "markdown")
        #expect(spans?[1].isEmpty == true)
    }

    @Test func fencesSpanLines() {
        let spans = highlightLines("```\nx\n```", language: "markdown")
        #expect(spans?.allSatisfy { $0.first?.kind == .string } == true)
    }
}
