import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinToolMetadata } from "../chat/builtinTools.ts";
import {
  agentsDir,
  findSpecialist,
  loadCatalog,
  parseSpecialist,
  reloadCatalog,
  searchSpecialists,
} from "./catalog.ts";

const knownTools = new Set(Object.keys(builtinToolMetadata()));
const parse = (content: string) => parseSpecialist("x.md", content, "user", knownTools);

let dir: string;
const previous = process.env.YARVIS_AGENTS_DIR;

function writeAgent(name: string, content: string): void {
  writeFileSync(join(dir, `${name}.md`), content);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "yarvis-agents-"));
  process.env.YARVIS_AGENTS_DIR = dir;
  await reloadCatalog();
});

afterEach(async () => {
  if (previous === undefined) delete process.env.YARVIS_AGENTS_DIR;
  else process.env.YARVIS_AGENTS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  await reloadCatalog();
});

describe("parsing one definition", () => {
  const valid = [
    "---",
    "name: ticket-tidier",
    "description: Tidies tickets.",
    "tools: [list_tasks, recall]",
    "model: anthropic/claude-sonnet-5",
    "maxSteps: 6",
    "---",
    "You tidy tickets.",
  ].join("\n");

  it("reads the whole shape", () => {
    const parsed = parse(valid);
    expect(parsed).toMatchObject({
      name: "ticket-tidier",
      description: "Tidies tickets.",
      tools: ["list_tasks", "recall"],
      unattended: [],
      provider: "anthropic",
      model: "claude-sonnet-5",
      maxSteps: 6,
      enabled: true,
      source: "user",
    });
    expect(parsed.prompt).toBe("You tidy tickets.");
  });

  it("defaults the step budget, the enabled flag and the model", () => {
    const parsed = parse("---\nname: a\ndescription: d\n---\nprompt");
    expect(parsed.maxSteps).toBe(8);
    expect(parsed.enabled).toBe(true);
    expect(parsed.provider).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.tools).toEqual([]);
  });

  /**
   * A typo in a tool name has to be a visible problem: the alternative is a
   * specialist that quietly runs with nine of the ten tools its author listed.
   */
  it("rejects a tool that doesn't exist", () => {
    expect(() => parse("---\nname: a\ndescription: d\ntools: [recall, reclal]\n---\np")).toThrow(
      "unknown tool(s): reclal",
    );
  });

  it("rejects an unattended grant for a tool it never asked for", () => {
    expect(() =>
      parse(
        "---\nname: a\ndescription: d\ntools: [recall]\nunattended: [jira_create_issue]\n---\np",
      ),
    ).toThrow("missing from 'tools'");
  });

  it("requires a name, a description and a prompt", () => {
    expect(() => parse("---\ndescription: d\n---\np")).toThrow("'name' is required");
    expect(() => parse("---\nname: a\n---\np")).toThrow("'description' is required");
    expect(() => parse("---\nname: a\ndescription: d\n---\n")).toThrow("body is the system prompt");
  });

  it("rejects a name that isn't usable as a filename or an identifier", () => {
    for (const name of ['"Work Scout"', "work_scout", "-leading"]) {
      expect(() => parse(`---\nname: ${name}\ndescription: d\n---\np`)).toThrow(
        "must be lowercase letters, digits and hyphens",
      );
    }
    // An empty name is missing rather than malformed, and says so.
    expect(() => parse('---\nname: ""\ndescription: d\n---\np')).toThrow("'name' is required");
  });

  it("rejects a misspelled key rather than ignoring it", () => {
    expect(() => parse("---\nname: a\ndescription: d\ntool: recall\n---\np")).toThrow(
      "unknown key(s): tool",
    );
  });

  it("requires a model written as provider/model", () => {
    expect(() => parse("---\nname: a\ndescription: d\nmodel: sonnet\n---\np")).toThrow(
      "<provider>/<model>",
    );
  });

  it("caps the step budget a file may ask for", () => {
    expect(() => parse("---\nname: a\ndescription: d\nmaxSteps: 500\n---\np")).toThrow(
      "cannot exceed 30",
    );
  });
});

describe("the catalogue", () => {
  it("ships the built-in definitions, parsed", async () => {
    const { specialists, problems } = await loadCatalog();
    expect(problems).toEqual([]);
    expect(specialists.map((s) => s.name)).toEqual([
      "activity-consolidator",
      "planner",
      "project-manager",
      "session-summarizer",
      "work-scout",
    ]);
    expect(specialists.every((s) => s.source === "builtin")).toBe(true);
    // The one deliberate unattended grant in the shipped set.
    const granted = specialists.filter((s) => s.unattended.length > 0);
    expect(granted.map((s) => s.name)).toEqual(["project-manager"]);
    expect(granted[0]!.unattended).toEqual(["jira_create_issue"]);
  });

  it("picks up a user definition beside the built-ins", async () => {
    writeAgent("ticket-tidier", "---\nname: ticket-tidier\ndescription: Tidies.\n---\nYou tidy.");
    const { specialists } = await reloadCatalog();
    const mine = specialists.find((s) => s.name === "ticket-tidier");
    expect(mine?.source).toBe("user");
    expect(mine?.path).toBe(join(dir, "ticket-tidier.md"));
  });

  /**
   * Precedence is the whole reason files beat rows: a shipped prompt keeps
   * improving with the app, and an override stays the user's.
   */
  it("lets a user definition replace a built-in of the same name", async () => {
    // Description with a comma on purpose: prose has commas, and a parser that
    // read one as a list separator dropped the override with a confusing error.
    writeAgent(
      "planner",
      "---\nname: planner\ndescription: Mine, tuned.\ntools: [recall]\n---\nMy way.",
    );
    const { specialists } = await reloadCatalog();
    const planner = specialists.filter((s) => s.name === "planner");
    expect(planner.length).toBe(1);
    expect(planner[0]).toMatchObject({
      source: "user",
      description: "Mine, tuned.",
      prompt: "My way.",
    });
  });

  it("reports a file it cannot parse instead of dropping it silently", async () => {
    writeAgent("broken", "no frontmatter here");
    const { specialists, problems } = await reloadCatalog();
    expect(problems.length).toBe(1);
    expect(problems[0]!.message).toContain("frontmatter fence");
    // The rest still load.
    expect(specialists.length).toBe(5);
  });

  it("treats a missing directory as no user definitions", async () => {
    rmSync(dir, { recursive: true, force: true });
    const { specialists, problems } = await reloadCatalog();
    expect(problems).toEqual([]);
    expect(specialists.length).toBe(5);
    mkdirSync(dir, { recursive: true });
  });

  it("ignores anything that isn't a .md file", async () => {
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    mkdirSync(join(dir, "nested.md"));
    const { specialists, problems } = await reloadCatalog();
    expect(problems).toEqual([]);
    expect(specialists.length).toBe(5);
  });

  it("resolves a name case-insensitively, and answers null for an unknown one", async () => {
    expect((await findSpecialist("Work-Scout"))?.name).toBe("work-scout");
    expect(await findSpecialist("nobody")).toBeNull();
  });

  it("leaves out a definition disabled in its own frontmatter", async () => {
    writeAgent("planner", "---\nname: planner\ndescription: d\nenabled: false\n---\nprompt");
    await reloadCatalog();
    expect(await searchSpecialists("what should I work on next")).not.toContain(
      expect.objectContaining({ name: "planner" }),
    );
    expect((await findSpecialist("planner"))?.enabled).toBe(false);
  });

  it("names the directory it reads, so the UI can tell the user where to write", async () => {
    expect((await reloadCatalog()).userDir).toBe(dir);
    expect(agentsDir()).toBe(dir);
  });
});

describe("choosing a specialist", () => {
  it("ranks by what the work is about", async () => {
    const matches = await searchSpecialists("summarize this coding session transcript");
    expect(matches[0]!.specialist.name).toBe("session-summarizer");
  });

  it("puts a name match first, since that is what the user says out loud", async () => {
    const matches = await searchSpecialists("ask the planner");
    expect(matches[0]!.specialist.name).toBe("planner");
  });

  it("returns everything for an empty query rather than nothing", async () => {
    expect((await searchSpecialists("")).length).toBe(5);
  });
});
