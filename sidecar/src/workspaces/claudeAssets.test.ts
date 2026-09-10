import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      { prefix: "api", sourceDir: "/api", entries: [{ entry: "deploy", id: "deploy" }] },
      { prefix: "web", sourceDir: "/web", entries: [{ entry: "lint", id: "lint" }] },
    ]);
    expect(copies.map((c) => c.name)).toEqual(["deploy", "lint"]);
    expect(skipped).toEqual([]);
  });

  it("prefixes every repo offering a contested name, so neither one wins by order", () => {
    const repos = [
      { prefix: "api", sourceDir: "/api", entries: [{ entry: "deploy", id: "deploy" }] },
      { prefix: "web", sourceDir: "/web", entries: [{ entry: "deploy", id: "deploy" }] },
    ];
    const forwards = planAssetCopies(repos).copies.map((c) => c.name);
    const backwards = planAssetCopies([...repos].reverse()).copies.map((c) => c.name);
    expect(forwards.sort()).toEqual(["api-deploy", "web-deploy"]);
    expect(backwards.sort()).toEqual(["api-deploy", "web-deploy"]);
  });

  it("gives way to an entry already in the destination", () => {
    const { copies } = planAssetCopies(
      [{ prefix: "api", sourceDir: "/api", entries: [{ entry: "deploy", id: "deploy" }] }],
      [{ entry: "deploy", id: "deploy" }],
    );
    expect(copies.map((c) => c.name)).toEqual(["api-deploy"]);
  });

  it("skips rather than overwrites when the prefixed name is taken too", () => {
    const { copies, skipped } = planAssetCopies(
      [{ prefix: "api", sourceDir: "/api", entries: [{ entry: "deploy", id: "deploy" }] }],
      [
        { entry: "deploy", id: "deploy" },
        { entry: "api-deploy", id: "api-deploy" },
      ],
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

  it("ignores a manifest name that would escape the destination directory", () => {
    const repo = writeSkill("api", "deploy");
    syncClaudeAssets(workspace, [repo]);
    const settings = join(workspace, ".claude", "settings.json");
    writeFileSync(settings, "{}");
    writeFileSync(
      join(workspace, ".claude", ".yarvis-copied.json"),
      JSON.stringify({ skills: ["..", ".", "deploy"], agents: [] }),
    );

    syncClaudeAssets(workspace, [repo]);

    // Every manifest name is handed to `rm -r`, so `..` would take the whole
    // .claude directory — hooks config included — with it.
    expect(existsSync(settings)).toBe(true);
  });

  it("copies normally when the manifest is corrupt", () => {
    const repo = writeSkill("api", "deploy");
    const manifest = join(workspace, ".claude", ".yarvis-copied.json");
    mkdirSync(join(workspace, ".claude"), { recursive: true });

    for (const payload of ["not json", "null", "[]", '{"skills":"deploy"}', '{"skills":[7,""]}']) {
      rmSync(join(workspace, ".claude"), { recursive: true, force: true });
      mkdirSync(join(workspace, ".claude"), { recursive: true });
      writeFileSync(manifest, payload);
      expect(syncClaudeAssets(workspace, [repo]).skills).toEqual(["deploy"]);
    }
  });

  it("prefixes agents whose filenames differ but whose declared names collide", () => {
    const api = join(workspace, "api", ".claude", "agents");
    const web = join(workspace, "web", ".claude", "agents");
    mkdirSync(api, { recursive: true });
    mkdirSync(web, { recursive: true });
    writeFileSync(join(api, "reviewer.md"), "---\nname: reviewer\ndescription: R.\n---\n");
    writeFileSync(join(web, "code-reviewer.md"), "---\nname: reviewer\ndescription: R.\n---\n");

    const copied = syncClaudeAssets(workspace, [join(workspace, "api"), join(workspace, "web")]);

    // Claude Code addresses an agent by its declared name, so matching filenames
    // are neither necessary nor sufficient for a collision.
    expect(copied.agents.sort()).toEqual(["api-reviewer.md", "web-code-reviewer.md"]);
    const agents = join(workspace, ".claude", "agents");
    expect(readFileSync(join(agents, "api-reviewer.md"), "utf8")).toContain("name: api-reviewer");
    expect(readFileSync(join(agents, "web-code-reviewer.md"), "utf8")).toContain(
      "name: web-reviewer",
    );
  });

  it("leaves an agent's declared name alone when only the filename is shared", () => {
    const api = join(workspace, "api", ".claude", "agents");
    const web = join(workspace, "web", ".claude", "agents");
    mkdirSync(api, { recursive: true });
    mkdirSync(web, { recursive: true });
    writeFileSync(join(api, "reviewer.md"), "---\nname: pr-reviewer\ndescription: R.\n---\n");
    writeFileSync(join(web, "reviewer.md"), "---\nname: web-reviewer\ndescription: R.\n---\n");

    const copied = syncClaudeAssets(workspace, [join(workspace, "api"), join(workspace, "web")]);

    // The files must both fit in one directory, but the identities never clashed
    // and renaming them would break whatever referenced them.
    expect(copied.agents.sort()).toEqual(["api-reviewer.md", "web-reviewer.md"]);
    const agents = join(workspace, ".claude", "agents");
    expect(readFileSync(join(agents, "api-reviewer.md"), "utf8")).toContain("name: pr-reviewer");
    expect(readFileSync(join(agents, "web-reviewer.md"), "utf8")).toContain("name: web-reviewer");
  });

  it("names a copy that declares no name of its own", () => {
    const api = join(workspace, "api", ".claude", "agents");
    const web = join(workspace, "web", ".claude", "agents");
    for (const dir of [api, web]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "reviewer.md"), "---\ndescription: Reviews.\n---\n");
    }

    syncClaudeAssets(workspace, [join(workspace, "api"), join(workspace, "web")]);

    // Without a name to rewrite the two copies would rely on whatever the loader
    // falls back to; giving them one makes them distinct whatever that is.
    const copy = readFileSync(join(workspace, ".claude", "agents", "api-reviewer.md"), "utf8");
    expect(copy).toContain("name: api-reviewer");
    expect(copy).toContain("description: Reviews.");
  });

  it("renames a CRLF definition without disturbing its body", () => {
    const api = join(workspace, "api", ".claude", "agents");
    const web = join(workspace, "web", ".claude", "agents");
    for (const dir of [api, web]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "reviewer.md"), "---\r\nname: reviewer\r\n---\r\nBody\r\n");
    }

    syncClaudeAssets(workspace, [join(workspace, "api"), join(workspace, "web")]);

    const copy = readFileSync(join(workspace, ".claude", "agents", "web-reviewer.md"), "utf8");
    expect(copy).toContain("name: web-reviewer");
    expect(copy).toEndWith("Body\r\n");
  });

  it("leaves a copy without frontmatter untouched", () => {
    const api = join(workspace, "api", ".claude", "agents");
    const web = join(workspace, "web", ".claude", "agents");
    for (const dir of [api, web]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "reviewer.md"), "Just a body.\n");
    }

    syncClaudeAssets(workspace, [join(workspace, "api"), join(workspace, "web")]);

    const copy = readFileSync(join(workspace, ".claude", "agents", "api-reviewer.md"), "utf8");
    expect(copy).toBe("Just a body.\n");
  });

  it("skips rather than overwriting when both names are the user's own", () => {
    const repo = writeSkill("api", "deploy");
    for (const name of ["deploy", "api-deploy"]) {
      const dir = join(copiedSkills(), name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "mine");
    }

    const copied = syncClaudeAssets(workspace, [repo]);

    expect(copied.skills).toEqual([]);
    expect(readFileSync(join(copiedSkills(), "deploy", "SKILL.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(copiedSkills(), "api-deploy", "SKILL.md"), "utf8")).toBe("mine");
  });

  it("refuses a symlinked entry rather than writing through it", () => {
    const victim = join(root, "victim.md");
    writeFileSync(victim, "---\nname: victim\n---\n");
    for (const repo of ["api", "web"]) {
      const dir = join(workspace, repo, ".claude", "agents");
      mkdirSync(dir, { recursive: true });
      symlinkSync(victim, join(dir, "reviewer.md"));
    }

    const copied = syncClaudeAssets(workspace, [join(workspace, "api"), join(workspace, "web")]);

    // cpSync preserves a symlink, so a copy of one would still point at the
    // source's target and the frontmatter rewrite would overwrite that file.
    expect(copied.agents).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("---\nname: victim\n---\n");
  });

  it("refuses a symlinked SKILL.md inside a copied skill directory", () => {
    const victim = join(root, "skill-victim.md");
    writeFileSync(victim, "---\nname: victim\n---\n");
    for (const repo of ["api", "web"]) {
      const dir = join(workspace, repo, ".claude", "skills", "deploy");
      mkdirSync(dir, { recursive: true });
      symlinkSync(victim, join(dir, "SKILL.md"));
    }

    syncClaudeAssets(workspace, [join(workspace, "api"), join(workspace, "web")]);

    expect(lstatSync(join(copiedSkills(), "api-deploy", "SKILL.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("---\nname: victim\n---\n");
  });

  it("ignores entries that are not shaped like the kind", () => {
    const skills = join(workspace, "api", ".claude", "skills");
    const agents = join(workspace, "api", ".claude", "agents");
    mkdirSync(skills, { recursive: true });
    mkdirSync(join(agents, "notes"), { recursive: true });
    writeFileSync(join(skills, "README.md"), "not a skill");
    writeFileSync(join(agents, "config.json"), "{}");

    expect(syncClaudeAssets(workspace, [join(workspace, "api")])).toEqual({
      skills: [],
      agents: [],
    });
  });

  it("writes an empty manifest for a workspace with no repos", () => {
    expect(syncClaudeAssets(workspace, [])).toEqual({ skills: [], agents: [] });
    expect(existsSync(join(workspace, ".claude", ".yarvis-copied.json"))).toBe(true);
  });
});
