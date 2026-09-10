import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAssetCopies, syncClaudeAssets } from "./claudeAssets.ts";

const root = mkdtempSync(join(tmpdir(), "yarvis-claude-assets-"));
const workspace = join(root, "workspace");

beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes `<workspace>/<repo>/.claude/skills/<name>/SKILL.md`. */
function writeSkill(repo: string, name: string): string {
  const dir = join(workspace, repo, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A ${name} skill.\n---\n\nBody.\n`,
  );
  return join(workspace, repo);
}

/** Writes `<workspace>/<repo>/.claude/agents/<name>.md`. */
function writeAgent(repo: string, name: string): string {
  const dir = join(workspace, repo, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: A ${name} agent.\n---\n`,
  );
  return join(workspace, repo);
}

const copiedSkills = () => join(workspace, ".claude", "skills");

describe("planAssetCopies", () => {
  it("keeps the plain name when only one repo offers it", () => {
    const { copies, skipped } = planAssetCopies([
      { prefix: "api", sourceDir: "/api", entries: ["deploy"] },
      { prefix: "web", sourceDir: "/web", entries: ["lint"] },
    ]);
    expect(copies.map((c) => c.name)).toEqual(["deploy", "lint"]);
    expect(skipped).toEqual([]);
  });

  it("prefixes every repo offering a contested name, so neither one wins by order", () => {
    const repos = [
      { prefix: "api", sourceDir: "/api", entries: ["deploy"] },
      { prefix: "web", sourceDir: "/web", entries: ["deploy"] },
    ];
    const forwards = planAssetCopies(repos).copies.map((c) => c.name);
    const backwards = planAssetCopies([...repos].reverse()).copies.map((c) => c.name);
    expect(forwards.sort()).toEqual(["api-deploy", "web-deploy"]);
    expect(backwards.sort()).toEqual(["api-deploy", "web-deploy"]);
  });

  it("gives way to an entry already in the destination", () => {
    const { copies } = planAssetCopies(
      [{ prefix: "api", sourceDir: "/api", entries: ["deploy"] }],
      new Set(["deploy"]),
    );
    expect(copies.map((c) => c.name)).toEqual(["api-deploy"]);
  });

  it("skips rather than overwrites when the prefixed name is taken too", () => {
    const { copies, skipped } = planAssetCopies(
      [{ prefix: "api", sourceDir: "/api", entries: ["deploy"] }],
      new Set(["deploy", "api-deploy"]),
    );
    expect(copies).toEqual([]);
    expect(skipped.map((c) => c.entry)).toEqual(["deploy"]);
  });
});

describe("syncClaudeAssets", () => {
  it("copies a repo's skills and agents into the workspace root", () => {
    const repo = writeSkill("api", "deploy");
    writeAgent("api", "reviewer");

    const copied = syncClaudeAssets(workspace, [repo]);

    expect(copied).toEqual({ skills: ["deploy"], agents: ["reviewer.md"] });
    expect(readFileSync(join(copiedSkills(), "deploy", "SKILL.md"), "utf8")).toContain("Body.");
    expect(existsSync(join(workspace, ".claude", "agents", "reviewer.md"))).toBe(true);
  });

  it("prefixes a name two repos share, and renames the agent it declares", () => {
    const api = writeAgent("api", "reviewer");
    const web = writeAgent("web", "reviewer");
    writeSkill("api", "deploy");
    writeSkill("web", "deploy");

    const copied = syncClaudeAssets(workspace, [api, web]);

    expect(copied.skills.sort()).toEqual(["api-deploy", "web-deploy"]);
    expect(copied.agents.sort()).toEqual(["api-reviewer.md", "web-reviewer.md"]);
    // An agent is addressed by its frontmatter name, so the file rename alone
    // would leave both copies answering to "reviewer".
    const agent = readFileSync(join(workspace, ".claude", "agents", "api-reviewer.md"), "utf8");
    expect(agent).toContain("name: api-reviewer");
    expect(agent).toContain("description: A reviewer agent.");
    const skill = readFileSync(join(copiedSkills(), "api-deploy", "SKILL.md"), "utf8");
    expect(skill).toContain("name: api-deploy");
  });

  it("removes the previous run's copies when a repo leaves the workspace", () => {
    const api = writeSkill("api", "deploy");
    const web = writeSkill("web", "lint");
    syncClaudeAssets(workspace, [api, web]);

    const copied = syncClaudeAssets(workspace, [api]);

    expect(copied.skills).toEqual(["deploy"]);
    expect(existsSync(join(copiedSkills(), "lint"))).toBe(false);
  });

  it("re-copies without stacking a prefix on the second run", () => {
    const api = writeSkill("api", "deploy");
    syncClaudeAssets(workspace, [api]);

    const copied = syncClaudeAssets(workspace, [api]);

    expect(copied.skills).toEqual(["deploy"]);
  });

  it("leaves a skill the user put in the workspace root alone", () => {
    const repo = writeSkill("api", "deploy");
    const own = join(copiedSkills(), "deploy");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "mine");

    const copied = syncClaudeAssets(workspace, [repo]);

    expect(copied.skills).toEqual(["api-deploy"]);
    expect(readFileSync(join(own, "SKILL.md"), "utf8")).toBe("mine");
  });

  it("writes an empty manifest for a workspace with no repos", () => {
    expect(syncClaudeAssets(workspace, [])).toEqual({ skills: [], agents: [] });
    expect(existsSync(join(workspace, ".claude", ".yarvis-copied.json"))).toBe(true);
  });
});
