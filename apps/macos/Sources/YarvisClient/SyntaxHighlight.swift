import Foundation

// A small tokenizer for the review's code views: keywords, strings, comments
// and numbers per language family. It colours, it doesn't parse, so a file
// mid-edit or in a language it half knows still reads.

public enum SyntaxTokenKind: UInt8, Sendable, Hashable {
    case keyword, string, comment, number, type, literal
}

/// A coloured stretch of one line, in UTF-16 offsets from the line's start.
public struct SyntaxSpan: Sendable, Equatable, Hashable {
    public var start: Int
    public var length: Int
    public var kind: SyntaxTokenKind

    public init(start: Int, length: Int, kind: SyntaxTokenKind) {
        self.start = start
        self.length = length
        self.kind = kind
    }
}

private let byExtension: [String: String] = [
    "bash": "bash", "c": "c", "cc": "cpp", "cjs": "javascript", "clj": "clojure", "cljs": "clojure",
    "conf": "ini", "cpp": "cpp", "cs": "csharp", "css": "css", "cts": "typescript", "cxx": "cpp",
    "dart": "dart", "erl": "erlang", "ex": "elixir", "exs": "elixir", "go": "go", "h": "c", "hh": "cpp",
    "hpp": "cpp", "hs": "haskell", "htm": "xml", "html": "xml", "hxx": "cpp", "ini": "ini", "java": "java",
    "js": "javascript", "json": "json", "jsonc": "json", "jsx": "javascript", "kt": "kotlin", "kts": "kotlin",
    "less": "less", "lua": "lua", "m": "objectivec", "markdown": "markdown", "md": "markdown",
    "mjs": "javascript", "mk": "makefile", "mm": "objectivec", "mts": "typescript", "php": "php",
    "pl": "perl", "pm": "perl", "proto": "protobuf", "ps1": "powershell", "py": "python", "pyi": "python",
    "rb": "ruby", "rake": "ruby", "rs": "rust", "sass": "scss", "sbt": "scala", "scala": "scala",
    "scss": "scss", "sh": "bash", "sql": "sql", "svg": "xml", "swift": "swift",
    // TOML is close enough to INI for key, value and section colouring.
    "toml": "ini", "ts": "typescript", "tsx": "typescript", "xml": "xml", "yaml": "yaml", "yml": "yaml",
    "zsh": "bash",
]

private let byFilename: [String: String] = [
    "brewfile": "ruby", "dockerfile": "dockerfile", "gemfile": "ruby", "makefile": "makefile",
    "podfile": "ruby", "rakefile": "ruby",
]

/// The language for a path, by whole filename and then extension, or nil.
/// Same table as the web's `languageForPath`, so both colour the same files.
public func languageForPath(_ path: String) -> String? {
    let name = (path.split(separator: "/").last.map(String.init) ?? "").lowercased()
    if let language = byFilename[name] { return language }
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return nil }
    return byExtension[String(name[name.index(after: dot)...])]
}

/// Past any of these a file is generated, minified or data: nobody reads it
/// a token at a time, and colouring it would cost more than it gives.
public let maxHighlightCharacters = 400_000
public let maxHighlightLines = 20_000
/// A line this long is a minified bundle with its newlines stripped.
public let maxHighlightLineLength = 2_000

/// Spans per line of `code` (split on "\n"), or nil when the language is
/// unknown or the file is too large to be worth colouring. Whole-document,
/// so a block comment or multi-line string colours every line it covers.
public func highlightLines(_ code: String, language: String) -> [[SyntaxSpan]]? {
    guard let spec = LanguageSpec.forLanguage(language) else { return nil }
    let units = Array(code.utf16)
    guard units.count <= maxHighlightCharacters else { return nil }
    var lines = 1
    var lineStart = 0
    for (i, u) in units.enumerated() where u == newline {
        if i - lineStart > maxHighlightLineLength { return nil }
        lineStart = i + 1
        lines += 1
        if lines > maxHighlightLines { return nil }
    }
    if units.count - lineStart > maxHighlightLineLength { return nil }
    return Tokenizer(units: units, spec: spec).run()
}

private let newline: UInt16 = 10

private struct LanguageSpec {
    var lineComments: [String] = []
    var blockComments: [(String, String)] = []
    /// Quotes whose strings end at the line's end if left open.
    var quotes: [String] = ["\"", "'"]
    /// Quotes whose strings may run over several lines.
    var multilineQuotes: [String] = []
    /// A `'…'` longer than this is not a character literal (a Rust lifetime, say).
    var maxSingleQuote: Int?
    var backslashEscapes = true
    var keywords: Set<String> = []
    var literals: Set<String> = ["true", "false", "null"]
    var caseInsensitive = false
    /// Capitalised identifiers read as types.
    var capitalisedTypes = false
    /// `$` and `-` count as identifier characters (shell variables, CSS properties).
    var identifierExtras: Set<UInt16> = [36]
    /// A line that starts with this (after spaces) is a heading or section.
    var headingPrefix: String?
    /// `<name` and `</name` colour the name.
    var tags = false
    /// A word followed by `:` or `=` at the start of a line is a key.
    var keysAtLineStart = false

    static func forLanguage(_ language: String) -> LanguageSpec? {
        let cLike = ["//"]
        let cBlock = [("/*", "*/")]
        switch language {
        case "javascript", "typescript":
            return LanguageSpec(
                lineComments: cLike, blockComments: cBlock, multilineQuotes: ["`"],
                keywords: words("""
                    abstract any as async await boolean break case catch class const constructor continue debugger
                    declare default delete do else enum export extends finally for from function get if implements
                    import in infer instanceof interface keyof let namespace never new number of private protected
                    public readonly return satisfies set static string super switch this throw try type typeof
                    undefined unknown var void while with yield
                    """),
                literals: ["true", "false", "null", "undefined", "NaN", "Infinity"], capitalisedTypes: true)
        case "c", "cpp", "objectivec":
            return LanguageSpec(
                lineComments: cLike, blockComments: cBlock, maxSingleQuote: 6,
                keywords: words("""
                    auto bool break case catch char class const constexpr continue default define delete do double
                    else endif enum explicit extern float for friend goto if ifdef ifndef include inline int long
                    namespace new noexcept nullptr operator override private protected public register return short
                    signed sizeof static struct switch template this throw try typedef typename union unsigned using
                    virtual void volatile while id self super nil YES NO interface implementation property end
                    """),
                literals: ["true", "false", "NULL", "nullptr", "nil", "YES", "NO"], capitalisedTypes: true)
        case "java", "kotlin", "scala", "csharp", "dart", "groovy":
            return LanguageSpec(
                lineComments: cLike, blockComments: cBlock, multilineQuotes: ["\"\"\""], maxSingleQuote: 8,
                keywords: words("""
                    abstract as async await base boolean break byte case catch char class companion const continue
                    data def default do double else enum extends extension final finally float for fun if implements
                    import in init instanceof int interface internal is lateinit late let long match namespace new
                    object open operator out override package private protected public readonly record required
                    return sealed short static string struct super suspend switch synchronized this throw throws
                    trait try typealias using val value var virtual void volatile when where while with yield
                    """),
                literals: ["true", "false", "null"], capitalisedTypes: true)
        case "go":
            return LanguageSpec(
                lineComments: cLike, blockComments: cBlock, multilineQuotes: ["`"], maxSingleQuote: 8,
                backslashEscapes: true,
                keywords: words("""
                    break case chan const continue default defer else fallthrough for func go goto if import
                    interface map package range return select struct switch type var any bool byte error float64
                    int int64 rune string uint
                    """),
                literals: ["true", "false", "nil", "iota"], capitalisedTypes: true)
        case "rust":
            return LanguageSpec(
                lineComments: cLike, blockComments: cBlock, maxSingleQuote: 4,
                keywords: words("""
                    as async await break const continue crate dyn else enum extern fn for if impl in let loop match
                    mod move mut pub ref return self Self static struct super trait type unsafe use where while
                    """),
                literals: ["true", "false", "None", "Some", "Ok", "Err"], capitalisedTypes: true)
        case "swift":
            return LanguageSpec(
                lineComments: cLike, blockComments: cBlock, quotes: ["\""], multilineQuotes: ["\"\"\""],
                keywords: words("""
                    actor any as associatedtype async await break case catch class continue default defer deinit do
                    else enum extension fallthrough fileprivate final for func guard if import in indirect init inout
                    internal is lazy let mutating nonisolated open operator override private protocol public repeat
                    rethrows return self Self some static struct subscript super switch throw throws try typealias
                    var weak where while
                    """),
                literals: ["true", "false", "nil"], capitalisedTypes: true)
        case "php":
            return LanguageSpec(
                lineComments: ["//", "#"], blockComments: cBlock,
                keywords: words("""
                    abstract array as break case catch class const continue declare default do echo else elseif
                    enum extends final finally fn for foreach function global if implements include interface match
                    namespace new private protected public readonly require return static switch throw trait try use
                    var while yield
                    """),
                literals: ["true", "false", "null", "TRUE", "FALSE", "NULL"], capitalisedTypes: true)
        case "css", "less", "scss":
            return LanguageSpec(
                lineComments: language == "css" ? [] : cLike, blockComments: cBlock,
                keywords: words("important media import include mixin extend supports keyframes font-face"),
                literals: [], identifierExtras: [36, 45])
        case "python":
            return LanguageSpec(
                lineComments: ["#"], quotes: ["\"", "'"], multilineQuotes: ["\"\"\"", "'''"],
                keywords: words("""
                    and as assert async await break case class continue def del elif else except finally for from
                    global if import in is lambda match nonlocal not or pass raise return self try while with yield
                    """),
                literals: ["True", "False", "None"], capitalisedTypes: true)
        case "ruby":
            return LanguageSpec(
                lineComments: ["#"],
                keywords: words("""
                    alias and begin break case class def defined do else elsif end ensure for if in module next not
                    or redo rescue retry return self super then undef unless until when while yield require
                    attr_reader attr_accessor private protected
                    """),
                literals: ["true", "false", "nil"], capitalisedTypes: true)
        case "elixir":
            return LanguageSpec(
                lineComments: ["#"], multilineQuotes: ["\"\"\""],
                keywords: words("after alias and case catch cond def defmodule defp do else end fn for if import in not or quote raise receive require rescue try unless use when with"),
                literals: ["true", "false", "nil"], capitalisedTypes: true)
        case "perl":
            return LanguageSpec(
                lineComments: ["#"],
                keywords: words("my our local sub if elsif else unless while until for foreach return use package require last next die print"),
                literals: [])
        case "bash", "dockerfile", "makefile":
            var spec = LanguageSpec(
                lineComments: ["#"], backslashEscapes: true,
                keywords: words("""
                    case do done elif else esac export fi for function if in local readonly return select then
                    until while FROM RUN CMD COPY ADD ENV ARG WORKDIR EXPOSE ENTRYPOINT LABEL USER VOLUME
                    """),
                literals: ["true", "false"])
            spec.identifierExtras = [36]
            return spec
        case "powershell":
            return LanguageSpec(
                lineComments: ["#"], blockComments: [("<#", "#>")],
                keywords: words("begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while"),
                literals: ["$true", "$false", "$null"], caseInsensitive: true)
        case "sql":
            return LanguageSpec(
                lineComments: ["--"], blockComments: cBlock, quotes: ["'", "\""],
                keywords: words("""
                    add all alter and as asc begin between by case check column commit constraint create cross
                    default delete desc distinct drop else end exists foreign from full group having if in index
                    inner insert into is join key left like limit not null offset on or order outer primary
                    references returning right rollback select set table then union unique update using values
                    view when where with
                    """),
                literals: ["true", "false", "null"], caseInsensitive: true)
        case "lua":
            return LanguageSpec(
                lineComments: ["--"], blockComments: [("--[[", "]]")],
                keywords: words("and break do else elseif end for function goto if in local not or repeat return then until while"),
                literals: ["true", "false", "nil"])
        case "haskell":
            return LanguageSpec(
                lineComments: ["--"], blockComments: [("{-", "-}")], quotes: ["\""],
                keywords: words("case class data deriving do else if import in infix instance let module newtype of then type where"),
                literals: ["True", "False", "Nothing", "Just"], capitalisedTypes: true)
        case "erlang":
            return LanguageSpec(
                lineComments: ["%"], quotes: ["\""],
                keywords: words("after begin case catch end fun if of receive try when module export"),
                literals: ["true", "false", "undefined"])
        case "clojure":
            return LanguageSpec(
                lineComments: [";"], quotes: ["\""],
                keywords: words("def defn defmacro fn let if when cond do loop recur ns require"),
                literals: ["true", "false", "nil"], identifierExtras: [36, 45])
        case "protobuf":
            return LanguageSpec(
                lineComments: cLike, blockComments: cBlock,
                keywords: words("syntax package import option message enum service rpc returns repeated optional required oneof map reserved string int32 int64 bool bytes double float uint32 uint64"),
                literals: ["true", "false"], capitalisedTypes: true)
        case "json":
            return LanguageSpec(lineComments: cLike, blockComments: cBlock, quotes: ["\""])
        case "yaml":
            return LanguageSpec(
                lineComments: ["#"], literals: ["true", "false", "null", "yes", "no", "on", "off"],
                identifierExtras: [36, 45], keysAtLineStart: true)
        case "ini":
            return LanguageSpec(
                lineComments: ["#", ";"], literals: ["true", "false"], identifierExtras: [36, 45],
                headingPrefix: "[", keysAtLineStart: true)
        case "xml":
            return LanguageSpec(blockComments: [("<!--", "-->")], backslashEscapes: false, literals: [],
                                identifierExtras: [45], tags: true)
        case "markdown":
            return LanguageSpec(quotes: ["`"], multilineQuotes: ["```"], backslashEscapes: false, literals: [],
                                headingPrefix: "#")
        default:
            return nil
        }
    }

    private static func words(_ s: String) -> Set<String> {
        Set(s.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init))
    }
}

private struct Tokenizer {
    let units: [UInt16]
    let spec: LanguageSpec
    private let lineComments: [[UInt16]]
    private let blocks: [([UInt16], [UInt16])]
    /// Longest first, so `"""` wins over `"`.
    private let quotes: [(open: [UInt16], multiline: Bool)]
    private let keywords: Set<String>
    private let literals: Set<String>

    init(units: [UInt16], spec: LanguageSpec) {
        self.units = units
        self.spec = spec
        lineComments = spec.lineComments.map { Array($0.utf16) }
        blocks = spec.blockComments.map { (Array($0.0.utf16), Array($0.1.utf16)) }
        quotes = (spec.multilineQuotes.map { (Array($0.utf16), true) } + spec.quotes.map { (Array($0.utf16), false) })
            .sorted { $0.0.count > $1.0.count }
        keywords = spec.caseInsensitive ? Set(spec.keywords.map { $0.lowercased() }) : spec.keywords
        literals = spec.caseInsensitive ? Set(spec.literals.map { $0.lowercased() }) : spec.literals
    }

    private func matches(_ token: [UInt16], at i: Int) -> Bool {
        guard !token.isEmpty, i + token.count <= units.count else { return false }
        for j in 0..<token.count where units[i + j] != token[j] { return false }
        return true
    }

    private func isIdentifierStart(_ u: UInt16) -> Bool {
        (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u == 95 || spec.identifierExtras.contains(u)
    }

    private func isIdentifierPart(_ u: UInt16) -> Bool {
        isIdentifierStart(u) || (u >= 48 && u <= 57)
    }

    private func isDigit(_ u: UInt16) -> Bool { u >= 48 && u <= 57 }

    func run() -> [[SyntaxSpan]] {
        var lines: [[SyntaxSpan]] = []
        var current: [SyntaxSpan] = []
        var lineStart = 0
        var i = 0
        let n = units.count

        // Adds a span from `start` to `end`, split at each newline it crosses.
        func emit(_ start: Int, _ end: Int, _ kind: SyntaxTokenKind) {
            var s = start
            var k = start
            while k < end {
                if units[k] == newline {
                    if k > s { current.append(SyntaxSpan(start: s - lineStart, length: k - s, kind: kind)) }
                    lines.append(current)
                    current = []
                    lineStart = k + 1
                    s = k + 1
                }
                k += 1
            }
            if end > s { current.append(SyntaxSpan(start: s - lineStart, length: end - s, kind: kind)) }
        }

        var atLineStart = true
        while i < n {
            let u = units[i]
            if u == newline {
                lines.append(current)
                current = []
                lineStart = i + 1
                i += 1
                atLineStart = true
                continue
            }
            if u == 32 || u == 9 {
                i += 1
                continue
            }
            let firstOnLine = atLineStart
            atLineStart = false

            if firstOnLine, let heading = spec.headingPrefix.map({ Array($0.utf16) }), matches(heading, at: i) {
                let end = endOfLine(i)
                emit(i, end, .keyword)
                i = end
                continue
            }
            if let open = blocks.first(where: { matches($0.0, at: i) }) {
                let end = find(open.1, from: i + open.0.count).map { $0 + open.1.count } ?? n
                emit(i, end, .comment)
                i = end
                continue
            }
            if lineComments.contains(where: { matches($0, at: i) }) {
                let end = endOfLine(i)
                emit(i, end, .comment)
                i = end
                continue
            }
            if let quote = quotes.first(where: { matches($0.open, at: i) }) {
                if let end = stringEnd(from: i, quote: quote.open, multiline: quote.multiline) {
                    emit(i, end, .string)
                    i = end
                    continue
                }
            }
            if spec.tags && u == 60 {
                var j = i + 1
                if j < n && units[j] == 47 { j += 1 }
                let nameStart = j
                while j < n && (isIdentifierPart(units[j]) || units[j] == 58 || units[j] == 46) { j += 1 }
                if j > nameStart {
                    emit(nameStart, j, .keyword)
                    i = j
                    continue
                }
            }
            if isDigit(u) && (i == 0 || !isIdentifierPart(units[i - 1])) {
                var j = i + 1
                while j < n && (isIdentifierPart(units[j]) || units[j] == 46) { j += 1 }
                emit(i, j, .number)
                i = j
                continue
            }
            if isIdentifierStart(u) {
                var j = i + 1
                while j < n && isIdentifierPart(units[j]) { j += 1 }
                let word = String(utf16CodeUnits: Array(units[i..<j]), count: j - i)
                let key = spec.caseInsensitive ? word.lowercased() : word
                if spec.keysAtLineStart && firstOnLine, isKeyFollow(j) {
                    emit(i, j, .keyword)
                } else if keywords.contains(key) {
                    emit(i, j, .keyword)
                } else if literals.contains(key) {
                    emit(i, j, .literal)
                } else if spec.capitalisedTypes && u >= 65 && u <= 90 {
                    emit(i, j, .type)
                }
                i = j
                continue
            }
            i += 1
        }
        lines.append(current)
        return lines
    }

    private func endOfLine(_ i: Int) -> Int {
        var j = i
        while j < units.count && units[j] != newline { j += 1 }
        return j
    }

    private func find(_ token: [UInt16], from start: Int) -> Int? {
        var j = start
        while j < units.count {
            if matches(token, at: j) { return j }
            j += 1
        }
        return nil
    }

    /// Where a string opened at `i` ends (past its closing quote). A
    /// single-line string left open ends at the line's end; a quote that
    /// can't be a character literal isn't a string at all.
    private func stringEnd(from i: Int, quote: [UInt16], multiline: Bool) -> Int? {
        let notCharLiteral = quote == [39] && spec.maxSingleQuote != nil
        var j = i + quote.count
        while j < units.count {
            let u = units[j]
            if u == newline && !multiline { return notCharLiteral ? nil : j }
            if u == 92 && spec.backslashEscapes {
                j += 2
                continue
            }
            if matches(quote, at: j) {
                let end = j + quote.count
                if quote == [39], let max = spec.maxSingleQuote, end - i > max + 2 { return nil }
                return end
            }
            j += 1
        }
        return notCharLiteral ? nil : units.count
    }

    /// A key is followed, after spaces, by `:` or `=`.
    private func isKeyFollow(_ j: Int) -> Bool {
        var k = j
        while k < units.count && (units[k] == 32 || units[k] == 45 || units[k] == 46 || isIdentifierPart(units[k])) {
            k += 1
        }
        return k < units.count && (units[k] == 58 || units[k] == 61)
    }
}
