import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { docNames, readDoc, searchDocs, splitSections } from "./docs.ts";

const DOCS_DIR = join(import.meta.dir, "../../../docs");

describe("splitSections", () => {
  it("splits at headings and keeps the chain", () => {
    const sections = splitSections("p", "# Top\nintro\n## Child\nbody\n### Leaf\nleaf body");
    expect(sections.map((s) => s.heading)).toEqual(["Top", "Top › Child", "Top › Child › Leaf"]);
  });

  it("doesn't read a shell comment in a code fence as a heading", () => {
    const sections = splitSections("p", "# Top\n```bash\n# install it\nbrew install x\n```");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain("# install it");
  });

  it("keeps deeper headings inside their parent", () => {
    const sections = splitSections("p", "## A\n#### Detail\ntext");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain("#### Detail");
  });
});

describe("the embedded docs", () => {
  it("include every user-facing feature page", () => {
    // A new page under docs/features/ that isn't imported in docs.ts is one the
    // guide can never find.
    const onDisk = readdirSync(join(DOCS_DIR, "features"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `features/${f.replace(/\.md$/, "")}`);
    expect(docNames()).toEqual(expect.arrayContaining(onDisk));
  });
});

describe("searchDocs", () => {
  it("finds where a GitHub token goes", () => {
    const [top] = searchDocs("where do I add my GitHub token");
    expect(top).toBeDefined();
    expect(`${top?.heading}\n${top?.snippet}`.toLowerCase()).toContain("github");
  });

  it("ranks a section covering every term above one repeating a single term", () => {
    const results = searchDocs("1password vault");
    expect(results[0]?.heading.toLowerCase()).toContain("1password");
  });

  it("returns nothing for a query of only filler words", () => {
    expect(searchDocs("how do I")).toEqual([]);
  });
});

describe("readDoc", () => {
  it("narrows to the sections whose heading matches", () => {
    const result = readDoc("configuration", "token scopes");
    expect(result && "text" in result && result.text).toContain("Token scopes");
  });

  it("lists the headings when the section doesn't exist", () => {
    const result = readDoc("configuration", "no such heading");
    expect(result && "headings" in result && result.headings.length).toBeGreaterThan(0);
  });

  it("accepts the page name with its .md suffix", () => {
    expect(readDoc("features/pr-review.md")).not.toBeNull();
  });

  it("is null for a page that doesn't exist", () => {
    expect(readDoc("development")).toBeNull();
  });

  it("doesn't resolve Object.prototype names as pages", () => {
    expect(readDoc("constructor")).toBeNull();
    expect(readDoc("toString", "anything")).toBeNull();
    expect(readDoc("__proto__")).toBeNull();
  });
});
