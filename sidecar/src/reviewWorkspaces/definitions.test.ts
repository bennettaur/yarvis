import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CappedGitRunner,
  definitionPatterns,
  type GrepResult,
  grepSymbol,
  importHints,
  isValidSymbol,
  type LanguageFamily,
  languageFamilyForPath,
  MAX_MATCHES_PER_FILE,
  parseGrepOutput,
  pickDefinitions,
  pickReferences,
  rankMatches,
  type SymbolMatch,
} from "./definitions.ts";
import { reviewGit } from "./git.ts";
import { sh } from "./testRepo.ts";

const declares = (family: LanguageFamily | null, symbol: string, line: string) =>
  definitionPatterns(family, symbol).strong.some((pattern) => pattern.test(line));
const weaklyDeclares = (family: LanguageFamily, symbol: string, line: string) =>
  definitionPatterns(family, symbol).weak.some((pattern) => pattern.test(line));

describe("isValidSymbol", () => {
  it("takes identifiers only", () => {
    for (const ok of ["foo", "_bar", "$el", "Foo123", "snake_case", "valid?", "save!"]) {
      expect(isValidSymbol(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "1abc",
      "a-b",
      "a.b",
      "-e",
      "--output=x",
      "a b",
      "a\nb",
      "ä",
      "a*",
      "a?b",
      "?",
      "a??",
    ]) {
      expect(isValidSymbol(bad)).toBe(false);
    }
    expect(isValidSymbol("a".repeat(201))).toBe(false);
  });
});

describe("languageFamilyForPath", () => {
  it("groups languages that call into each other", () => {
    expect(languageFamilyForPath("src/a.tsx")).toBe("js");
    expect(languageFamilyForPath("lib/b.mjs")).toBe("js");
    expect(languageFamilyForPath("A.java")).toBe("jvm");
    expect(languageFamilyForPath("B.kt")).toBe("jvm");
    expect(languageFamilyForPath("x.hpp")).toBe("c");
    expect(languageFamilyForPath("Makefile")).toBeNull();
    expect(languageFamilyForPath("notes.md")).toBeNull();
  });
});

describe("definitionPatterns", () => {
  const cases: [LanguageFamily | null, string, string[], string[]][] = [
    [
      "python",
      "load",
      ["def load(path):", "    async def load(self):", "class load:", "load = make_loader()"],
      ["    load(path)", "x = load()", "from a import load", "loader = 1", "load == 2"],
    ],
    [
      "go",
      "Serve",
      [
        "func Serve(w http.ResponseWriter) {",
        "func (s *Server) Serve() error {",
        "type Serve struct {",
        "\tServe struct {",
        "var Serve = 1",
        "\tServe Mode = 3",
        "\tServe = iota",
      ],
      [
        "\tgo s.Serve()",
        "return Serve(x)",
        "func Served() {",
        // Reassignments in a function body, at one indent or more.
        "\tServe = Serve + 1",
        "\t\tServe = 2",
        "\t\tServe int = 2",
      ],
    ],
    [
      "rust",
      "Parser",
      [
        "pub struct Parser {",
        "pub(crate) enum Parser<'a> {",
        "impl Parser {",
        "impl<T> Display for Parser {",
        "impl<T: Into<Vec<u8>>> From<Box<T>> for Parser {",
        "trait Parser {",
        "pub async fn Parser() {",
      ],
      ["let p = Parser::new();", "use crate::Parser;", "fn parse(p: Parser) {"],
    ],
    [
      "jvm",
      "render",
      [
        "  public String render(Model m) {",
        "  private static <T> List<T> render(int x) {",
        "  fun render(): String {",
        "  override fun render() = 1",
        "  @Override public void render() {",
        "  public <K, V extends Map<K, V>> Map<K, V> render(K k) {",
      ],
      [
        "    return render(m);",
        "    view.render();",
        "    String s = render(m);",
        "    new render(x);",
      ],
    ],
    [
      "jvm",
      "Widget",
      [
        "public class Widget {",
        "data class Widget(val x: Int)",
        "object Widget {",
        "interface Widget",
      ],
      ["Widget w = new Widget();"],
    ],
    [
      "csharp",
      "Handle",
      [
        "  public async Task<int> Handle(Request r) {",
        "  public int Handle { get; }",
        "  public void Handle() => Run();",
        "public class Handle {",
      ],
      ["    return Handle(r);", "    await Handle(r);", "    x.Handle();"],
    ],
    [
      "ruby",
      "call",
      [
        "  def call(env)",
        "  def self.call",
        "class call",
        "module Foo::call",
        "  attr_reader :x, :call",
      ],
      ["    call(env)", "    obj.call"],
    ],
    [
      "php",
      "render",
      [
        "  public function render($x) {",
        "function &render() {",
        "class render {",
        "const render = 1;",
      ],
      ["    $this->render($x);", "render();"],
    ],
    [
      "swift",
      "View",
      [
        "struct View {",
        "final class View: Base {",
        "protocol View {",
        "extension View {",
        "  private let View = 1",
      ],
      ["let v = View()", "View.make()"],
    ],
    [
      "js",
      "handler",
      [
        "export function handler(req) {",
        "export const handler = async () => {",
        "  async handler(req: Req): Promise<void> {",
        "export default class handler {",
        "type handler = () => void;",
        "  private handler: Fn;",
        "  handler = () => this.go();",
        "  handler = async (e: Event): Promise<void> => {",
        "  readonly handler = <T,>(x: T) => x;",
        "  handler: (req) => respond(req),",
        "  handler: async function (req) {",
        "  async handler<T extends Map<string, Array<T>>>(x: T) {",
      ],
      [
        "  handler(req);",
        "app.use(handler);",
        "import { handler } from './h';",
        "  return handler(x) {",
        "  handler: 3,",
        "  this.handler = makeHandler();",
      ],
    ],
    ["js", "Props", ["export type Props = { a: string };"], ["import type Props from './p';"]],
    [
      "c",
      "parse_args",
      [
        "int parse_args(int argc, char **argv) {",
        "static const char *parse_args(void)",
        "struct parse_args {",
        "#define parse_args(x) foo(x)",
        "} parse_args;",
      ],
      [
        "  parse_args(argc, argv);",
        "  return parse_args(1);",
        "int parse_args(int argc);",
        "  x = parse_args(1, 2",
      ],
    ],
    [
      null,
      "thing",
      ["def thing():", "fn thing() {", "func thing()", "class thing", "let thing = 1"],
      ["thing()", "x.thing"],
    ],
  ];

  for (const [family, symbol, yes, no] of cases) {
    it(`${family ?? "generic"}: finds declarations of ${symbol} and skips uses`, () => {
      for (const line of yes)
        expect({ line, hit: declares(family, symbol, line) }).toEqual({ line, hit: true });
      for (const line of no)
        expect({ line, hit: declares(family, symbol, line) }).toEqual({ line, hit: false });
    });
  }

  it("offers Python class attributes and dataclass fields only as weak candidates", () => {
    for (const line of ["    name: str", "    name: Optional[str] = None", "    name = 'x'"]) {
      expect({ line, strong: declares("python", "name", line) }).toEqual({ line, strong: false });
      expect({ line, weak: weaklyDeclares("python", "name", line) }).toEqual({ line, weak: true });
    }
    expect(weaklyDeclares("python", "name", "    name == other")).toBe(false);
  });

  it("finds a Ruby predicate or bang method", () => {
    expect(declares("ruby", "valid?", "  def valid?")).toBe(true);
    expect(declares("ruby", "save!", "  def save!(opts)")).toBe(true);
    expect(declares("ruby", "valid?", "  def valid_thing")).toBe(false);
  });

  it("treats the symbol as text, not a pattern", () => {
    expect(declares("js", "$el", "const $el = document.body;")).toBe(true);
    expect(declares("js", "$el", "const xel = 1;")).toBe(false);
  });
});

describe("parseGrepOutput", () => {
  it("reads path, line and text, including paths with odd characters", () => {
    const out =
      "abc:src/a.py\x0012\x00def foo():\nabc:dir with space/b:c.py\x003\x00foo()\nabc:x.py\x00bad\x00ignored\n";
    expect(parseGrepOutput(out, "abc")).toEqual([
      { path: "src/a.py", line: 12, text: "def foo():" },
      { path: "dir with space/b:c.py", line: 3, text: "foo()" },
    ]);
  });
});

describe("importHints", () => {
  it("reads imports across languages as path fragments", () => {
    expect(
      importHints("src/app/main.ts", 'import { a } from "./util/a";\nimport b from "@/lib/b";'),
    ).toEqual(expect.arrayContaining(["src/app/util/a", "@/lib/b"]));
    expect(importHints("pkg/x.py", "from app.models import User, Post\nimport os.path\n")).toEqual(
      expect.arrayContaining(["app/models", "app/models/User", "os/path"]),
    );
    expect(
      importHints("main.go", 'import (\n\t"fmt"\n\tsrv "github.com/o/r/internal/server"\n)\n'),
    ).toEqual(expect.arrayContaining(["fmt", "github.com/o/r/internal/server"]));
    expect(importHints("src/lib.rs", "use crate::parser::Parser;\n")).toEqual(["parser/Parser"]);
    expect(importHints("A.java", "import com.acme.widgets.Widget;\n")).toEqual([
      "com/acme/widgets/Widget",
    ]);
  });

  it("reads a bare quoted line as a Go import only in a Go file", () => {
    expect(importHints("a.ts", 'const names = [\n  "internal/server"\n];\n')).toEqual([]);
    expect(importHints("a.go", 'import (\n  "internal/server"\n)\n')).toEqual(["internal/server"]);
  });

  it("drops a relative import that climbs out of the repo", () => {
    expect(importHints("a.ts", 'import x from "../../outside";')).toEqual([]);
  });
});

describe("rankMatches", () => {
  const m = (path: string, line = 1): SymbolMatch => ({ path, line, column: 1, preview: "" });

  it("orders the file itself, its directory, its imports, then the rest", () => {
    const ranked = rankMatches(
      [
        m("z/other.py"),
        m("app/models/user.py"),
        m("pkg/sibling.py"),
        m("pkg/x.py", 40),
        m("pkg/x.py", 3),
      ],
      { path: "pkg/x.py", line: 5 },
      ["app/models/user"],
    );
    expect(ranked.map((r) => `${r.path}:${r.line}`)).toEqual([
      "pkg/x.py:3",
      "pkg/x.py:40",
      "pkg/sibling.py:1",
      "app/models/user.py:1",
      "z/other.py:1",
    ]);
  });

  it("matches a package import against a file in that directory", () => {
    const ranked = rankMatches(
      [m("cmd/a.go"), m("internal/server/server.go")],
      { path: "main.go" },
      ["github.com/o/r/internal/server"],
    );
    expect(ranked[0]?.path).toBe("internal/server/server.go");
  });
});

const grepOf = (lines: GrepResult["lines"], truncated = false): GrepResult => ({
  lines,
  truncated,
  timedOut: false,
});

describe("pickDefinitions", () => {
  it("skips comment lines in every language", () => {
    const found = grepOf([
      { path: "a.ts", line: 1, text: "// function render() is in b.ts" },
      { path: "a.py", line: 2, text: "# def render(): moved" },
      { path: "a.c", line: 3, text: " * int render(void) {" },
      { path: "a.sql", line: 4, text: "-- function render" },
      { path: "b.ts", line: 9, text: "export function render() {" },
      { path: "a.h", line: 5, text: "#define render(x) draw(x)" },
    ]);
    const result = pickDefinitions(found, { symbol: "render", path: "z.ts" });
    expect(result.matches.map((m) => m.path)).toEqual(["a.h", "b.ts"]);
  });

  it("ranks weak candidates after every strong one", () => {
    const found = grepOf([
      { path: "app/models.py", line: 3, text: "    name: str" },
      { path: "lib/other.py", line: 1, text: "def name():" },
    ]);
    const result = pickDefinitions(found, { symbol: "name", path: "app/models.py" });
    expect(result.matches.map((m) => m.path)).toEqual(["lib/other.py", "app/models.py"]);
  });

  it("carries the search's truncation through", () => {
    const found = grepOf([{ path: "a.py", line: 1, text: "def f():" }], true);
    expect(pickDefinitions(found, { symbol: "f", path: "a.py" }).truncated).toBe(true);
    expect(pickReferences(found, { symbol: "f", path: "a.py" }).truncated).toBe(true);
  });

  it("finds the column after a long prefix and keeps the preview short", () => {
    const text = `${" ".repeat(300)}def f():${"x".repeat(5000)}`;
    const result = pickReferences(grepOf([{ path: "a.py", line: 1, text }]), {
      symbol: "f",
      path: "a.py",
    });
    expect(result.matches[0]?.column).toBe(305);
    expect(result.matches[0]?.preview.length).toBeLessThanOrEqual(200);
  });
});

describe("pathological input", () => {
  const elapsed = (run: () => unknown) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it("reads imports out of hostile files in well under a second", () => {
    const inputs = [
      "\n".repeat(2_000_000),
      "import ".repeat(45_000),
      `import${" ".repeat(500_000)}`,
      `from ${"a.".repeat(200_000)}`,
      `"${"x".repeat(1_000_000)}`,
      `#include ${"\t".repeat(500_000)}`,
    ];
    for (const content of inputs) {
      for (const path of ["a.ts", "a.go", "a.py"]) {
        expect(elapsed(() => importHints(path, content))).toBeLessThan(250);
      }
    }
  });

  it("matches declaration patterns against long lines quickly", () => {
    const found = grepOf(
      ["  ".repeat(50_000), `int ${"* ".repeat(50_000)}f(`, `fn f${"<".repeat(50_000)}`].map(
        (text, i) => ({ path: `x${i}.c`, line: 1, text: `${text} f` }),
      ),
    );
    expect(elapsed(() => pickDefinitions(found, { symbol: "f", path: "a.c" }))).toBeLessThan(250);
  });
});

describe("against a real commit", () => {
  let repo: string;
  let sha: string;
  const runner = reviewGit().search;

  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "yarvis-defs-"));
    sh(repo, "init", "-q");
    write("app/models.py", "class User:\n    pass\n\ndef load_user(id):\n    return User()\n");
    write(
      "app/views.py",
      "from app.models import load_user\n\ndef show(id):\n    return load_user(id)\n",
    );
    write("other/models.py", "def load_user():\n    pass\n");
    write("web/user.ts", "export function load_user() {}\n");
    write("bin.dat", "load_user\u0000\u0001");
    // Generated and installed code is left out of every search.
    write("dist/models.py", "def load_user():\n    pass\n");
    write("web/node_modules/x/models.py", "def load_user():\n    pass\n");
    write("static/app.min.js", "function load_user(){}\n");
    write("gen/many.py", "load_user\n".repeat(MAX_MATCHES_PER_FILE + 5));
    sh(repo, "add", "-A", "-f");
    sh(repo, "commit", "-q", "-m", "fixture");
    sha = sh(repo, "rev-parse", "HEAD").trim();
    // A change after the commit must not be seen: the search reads the commit.
    write("app/models.py", "def load_user_changed():\n    pass\n");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("finds a Python definition, the imported module first, within the language", async () => {
    const found = await grepSymbol(runner, repo, sha, "load_user", "python");
    const result = pickDefinitions(found, {
      symbol: "load_user",
      path: "app/views.py",
      line: 4,
      content: "from app.models import load_user\n",
    });
    expect(result.matches.map((r) => `${r.path}:${r.line}:${r.column}`)).toEqual([
      "app/models.py:4:5",
      "other/models.py:1:5",
    ]);
    // gen/many.py reached the per-file cap, so there may be more.
    expect(result.truncated).toBe(true);
  });

  it("finds references as whole words, ranked from the asking file, less generated code", async () => {
    const found = await grepSymbol(runner, repo, sha, "load_user", "python");
    const result = pickReferences(found, { symbol: "load_user", path: "app/views.py", line: 4 });
    expect(result.matches.slice(0, 3).map((r) => `${r.path}:${r.line}`)).toEqual([
      "app/views.py:4",
      "app/views.py:1",
      "app/models.py:4",
    ]);
    expect(result.matches.some((r) => r.path.startsWith("dist/"))).toBe(false);
    expect(result.matches.some((r) => r.path.includes("node_modules"))).toBe(false);
    expect(result.matches.filter((r) => r.path === "gen/many.py")).toHaveLength(
      MAX_MATCHES_PER_FILE,
    );
  });

  it("leaves minified files out of an all-files search", async () => {
    const found = await grepSymbol(runner, repo, sha, "load_user", null);
    const paths = new Set(found.lines.map((line) => line.path));
    expect(paths.has("web/user.ts")).toBe(true);
    expect(paths.has("static/app.min.js")).toBe(false);
  });

  it("answers with nothing for a symbol nobody uses", async () => {
    const found = await grepSymbol(runner, repo, sha, "nowhere", "python");
    expect(found).toEqual({ lines: [], truncated: false, timedOut: false });
  });

  it("refuses a symbol that isn't an identifier before running git", async () => {
    await expect(grepSymbol(runner, repo, sha, "--open-files-in-pager=sh", null)).rejects.toThrow(
      "invalid symbol",
    );
  });

  it("stops git at the byte cap and reports what it had as truncated", async () => {
    let asked = 0;
    const capped: CappedGitRunner = (args, opts) => {
      asked = opts.maxBytes;
      return runner(args, { ...opts, maxBytes: 200 });
    };
    const found = await grepSymbol(capped, repo, sha, "load_user", null);
    expect(asked).toBeGreaterThan(0);
    expect(found.truncated).toBe(true);
    expect(found.lines.length).toBeGreaterThan(0);
    // Cut back to whole lines.
    expect(found.lines.every((line) => line.text.includes("load_user"))).toBe(true);
  });

  it("reports a search that ran out of time as timed out, with what it had", async () => {
    const slow: CappedGitRunner = async () => ({
      stdout: "",
      stderr: "",
      exitCode: 143,
      stopped: "timeout",
    });
    expect(await grepSymbol(slow, repo, sha, "x", "python")).toEqual({
      lines: [],
      truncated: true,
      timedOut: true,
    });
  });

  it("keeps git's error text out of what it throws", async () => {
    const failing: CappedGitRunner = async () => ({
      stdout: "",
      stderr: `fatal: bad object in ${repo}`,
      exitCode: 128,
      stopped: null,
    });
    const error = await grepSymbol(failing, repo, sha, "x", "python").catch((e: Error) => e);
    expect(String(error)).not.toContain(repo);
  });
});
