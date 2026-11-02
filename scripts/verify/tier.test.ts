import { describe, expect, it } from "bun:test";
import { classify, floorTier, isAdditiveMigration } from "./tier.ts";

const file = (path: string, additions = 10, deletions = 0) => ({ path, additions, deletions });

describe("classify", () => {
  it("treats a small frontend change as low risk", () => {
    expect(classify([file("src/components/Foo.tsx"), file("docs/features/x.md")]).tier).toBe("low");
  });

  it("treats a change to the verifier or CI as high risk, so it can't approve itself", () => {
    expect(classify([file("scripts/verify/gate.ts")]).tier).toBe("high");
    expect(classify([file(".github/workflows/verify.yml")]).tier).toBe("high");
  });

  it("treats secrets, permissions, the verifier's workflows and agent instructions as high risk", () => {
    for (const path of [
      "src-tauri/src/keychain.rs",
      "src-tauri/capabilities/default.json",
      "sidecar/src/agentTools/store.ts",
      ".github/workflows/verify.yml",
      ".github/workflows/verify-revert.yml",
      ".claude/skills/verify-pr/SKILL.md",
      ".claude/settings.json",
      "CLAUDE.md",
      "AGENTS.md",
      "sidecar/src/app.ts",
      "extension/page.js",
      "src-tauri/tauri.release.conf.json",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
  });

  it("presumes nothing about an area: frontend, sidecar and Rust code all start low", () => {
    // What the change does decides the rest, in the report's signed assessment.
    for (const path of ["src/App.tsx", "sidecar/src/memory/recall.ts", "src-tauri/src/alarms.rs"]) {
      expect(classify([file(path)]).tier).toBe("low");
    }
  });

  it("treats dependency changes as standard, for the skill's analysis to raise", () => {
    for (const path of ["bun.lock", "sidecar/package.json", "Cargo.toml", "src-tauri/Cargo.lock"]) {
      expect(classify([file(path)])).toEqual({
        tier: "standard",
        reasons: [`dependencies (${path})`],
        assess: [],
      });
    }
  });

  describe("a dependency file's added lines", () => {
    const changed = (path: string, addedText: string | null) => ({
      path,
      addedText,
      additions: 1,
      deletions: 1,
    });

    it("stay standard when they only name registry versions", () => {
      for (const [path, text] of [
        ["package.json", '    "zod": "^4.6.7",\n    "@babel/parser": "^8.0.8"'],
        ["src-tauri/Cargo.toml", 'serde = { version = "1.0.220", features = ["derive"] }'],
        ["pyproject.toml", '  "httpx>=0.28.1",'],
        ["bun.lock", '    "zod": ["zod@4.6.7", "", {}, "sha512-abc"],'],
        ["bun.lock", null],
      ] as const) {
        expect(classify([changed(path, text)]).tier).toBe("standard");
      }
    });

    it("need assessing when they change scripts or where a manifest gets a package", () => {
      for (const [path, text] of [
        ["package.json", '    "lint:fix": "biome check --write .",'],
        ["package.json", '    "left-pad": "github:someone/left-pad",'],
        ["src-tauri/Cargo.toml", 'build = "build.rs"'],
        ["src-tauri/Cargo.toml", "[patch.crates-io]"],
        ["src-tauri/Cargo.toml", 'foo = { git = "https://example.com/foo" }'],
      ] as const) {
        const result = classify([changed(path, text)]);
        expect(result.assess).toEqual([
          { path, reason: "a dependency file change beyond registry versions" },
        ]);
        expect(floorTier(result, [])).toBe("high");
        expect(floorTier(result, [path])).toBe("standard");
      }
    });

    it("are high for install hooks, verify scripts and lockfile sources outside the registry", () => {
      for (const [path, text] of [
        ["package.json", '    "postinstall": "node setup.js",'],
        ["sidecar/package.json", '    "prepare": "bun run build",'],
        ["package.json", '  "trustedDependencies": ["esbuild"],'],
        ["package.json", '    "verify:report": "bun run evil.ts",'],
        ["package.json", null],
        ["bun.lock", '    "zod": ["zod@4.6.7", "https://mirror.example/zod.tgz", {}, "sha512"],'],
        ["src-tauri/Cargo.lock", 'source = "git+https://example.com/foo#abc"'],
      ] as const) {
        const result = classify([changed(path, text)]);
        expect(result.tier).toBe("high");
        expect(result.assess).toEqual([]);
      }
    });
  });

  it("keeps what the verify workflows install and run with high", () => {
    for (const path of [
      "bunfig.toml",
      "tsconfig.json",
      ".npmrc",
      ".github/actions/setup/action.yml",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
  });

  it("keeps CI that reaches secrets, write tokens or privileged triggers high", () => {
    for (const text of [
      "        run: echo ${{ secrets.TOKEN }}",
      "  pull_request_target:",
      "  issue_comment:",
      "      contents: write",
      "        uses: actions/create-github-app-token@abc",
      '        run: echo "X=1" >> $GITHUB_ENV',
      "name: CI",
      null,
    ]) {
      const result = classify([
        { path: ".github/workflows/zz.yml", addedText: text, additions: 1, deletions: 0 },
      ]);
      expect(result.tier).toBe("high");
    }
    const routine = classify([
      {
        path: ".github/workflows/ci.yml",
        addedText: "      - run: bun run typecheck",
        additions: 1,
        deletions: 0,
      },
    ]);
    expect(routine.assess.map((a) => a.path)).toEqual([".github/workflows/ci.yml"]);
  });

  it("sends CI, git hooks, build config and the schema for assessment", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/dependabot.yml",
      "lefthook.yml",
      "sidecar/bunfig.toml",
      "tsconfig.app.json",
      "vite.config.ts",
      "sidecar/src/db/schema.ts",
    ]) {
      const result = classify([file(path)]);
      expect(result.assess.map((a) => a.path)).toEqual([path]);
      expect(floorTier(result, [])).toBe("high");
      expect(floorTier(result, [path])).toBe("standard");
    }
  });

  describe("migrations", () => {
    const migration = (addedText: string, deletions = 0) => ({
      path: "sidecar/drizzle/0050_new.sql",
      addedText,
      additions: 5,
      deletions,
    });

    it("are standard when they only add tables, columns, types or indexes", () => {
      const sql = `CREATE TYPE "public"."kind" AS ENUM('a', 'b');--> statement-breakpoint
CREATE TABLE "things" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "kind" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "things_kind_idx" ON "things" USING btree ("kind");`;
      expect(isAdditiveMigration(sql, 0)).toBe(true);
      expect(classify([migration(sql)])).toMatchObject({ tier: "standard", assess: [] });
    });

    it("need assessing when they drop, rename, retype or rewrite data", () => {
      for (const sql of [
        'DROP TABLE "things";',
        'ALTER TABLE "things" RENAME COLUMN "kind" TO "type";',
        'ALTER TABLE "things" ALTER COLUMN "kind" SET DATA TYPE text;',
        'ALTER TABLE "things" DROP COLUMN "kind";',
        `UPDATE "things" SET "kind" = 'a';`,
        'CREATE TABLE "x" ("id" int);--> statement-breakpoint\nDELETE FROM "y";',
        // A second statement in one chunk runs too.
        'CREATE TABLE "a" ("x" int); DROP TABLE "memories";',
        'CREATE TABLE "a" ("x" int)\n; DROP TABLE "memories";',
        'CREATE TABLE "a" ("x" int); DO $$ BEGIN DELETE FROM memories; END $$;',
        'CREATE TABLE "a" AS SELECT * FROM "memories";',
        'CREATE UNIQUE INDEX "u" ON "memories" ("content");',
        'ALTER TABLE "notes" ADD CONSTRAINT "f" FOREIGN KEY ("m") REFERENCES "memories"("id");',
        'ALTER TABLE "notes" ADD COLUMN "owner" text NOT NULL;',
        'CREATE EXTENSION IF NOT EXISTS "dblink";',
        'CREATE TABLE "a" ("x" int) /* ; DROP TABLE "memories" */;',
        "",
      ]) {
        expect(classify([migration(sql)]).assess).toHaveLength(1);
      }
    });

    it("need assessing when they edit a migration that already ran", () => {
      expect(classify([migration('CREATE INDEX "a" ON "b" ("c");', 1)]).assess).toHaveLength(1);
    });

    it("treats drizzle's snapshots and an appended journal entry as standard", () => {
      for (const path of [
        "sidecar/drizzle/meta/0050_snapshot.json",
        "sidecar/drizzle/meta/_journal.json",
      ]) {
        expect(classify([file(path, 7, 1)])).toMatchObject({ tier: "standard", assess: [] });
      }
    });

    it("assesses SQL outside the top level and journal edits to old entries", () => {
      for (const changed of [
        file("sidecar/drizzle/meta/0050_x.sql"),
        file("sidecar/drizzle/sub/0050_x.sql"),
        file("sidecar/drizzle/meta/_journal.json", 1, 1 + 1),
      ]) {
        expect(classify([changed]).assess).toHaveLength(1);
      }
    });

    it("allows NOT NULL on a new column with a default, and the vector extension", () => {
      expect(
        isAdditiveMigration('ALTER TABLE "t" ADD COLUMN "p" boolean DEFAULT false NOT NULL;', 0),
      ).toBe(true);
      expect(isAdditiveMigration('CREATE EXTENSION IF NOT EXISTS "vector";', 0)).toBe(true);
    });
  });

  it("raises the tier by size to standard at most, counting code but not tests or lockfiles", () => {
    expect(classify([file("src/App.tsx", 301)]).tier).toBe("standard");
    expect(classify([file("src/App.tsx", 5000, 3000)]).tier).toBe("standard");
    expect(classify([file("src/App.tsx", 10), file("src/App.test.tsx", 2000)]).tier).toBe("low");
  });

  it("treats the merge reviewer's half of the verifier as high risk", () => {
    for (const path of [
      "sidecar/src/verify/tools.ts",
      "sidecar/src/agents/definitions/merge-reviewer.md",
      "sidecar/src/agents/run.ts",
      "sidecar/src/chat/destructiveTools.ts",
      "sidecar/src/lib/fencing.ts",
      "sidecar/src/github/client.ts",
      "src-tauri/src/sidecar.rs",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
    expect(classify([file("sidecar/src/memory/recall.ts")]).tier).toBe("low");
  });

  it("keeps the verifier's own tests high risk", () => {
    expect(classify([file("scripts/verify/gate.test.ts")]).tier).toBe("high");
  });

  it("counts test preloads and helpers as code toward size, not as tests", () => {
    expect(classify([file("sidecar/src/test/setup.ts", 301)]).tier).toBe("standard");
  });

  it("classifies the old path of a renamed file", () => {
    const moved = {
      path: "src/lib/store.ts",
      previousPath: "sidecar/src/agentTools/store.ts",
      additions: 0,
      deletions: 0,
    };
    expect(classify([moved]).tier).toBe("high");
  });

  it("groups many files under one reason", () => {
    const result = classify([file("scripts/verify/a.ts"), file("scripts/verify/b.ts")]);
    expect(result.reasons).toEqual(["the verification layer itself (2 files)"]);
  });

  it("gives only the reasons for the tier that won", () => {
    const result = classify([file("src/App.tsx", 400), file("CLAUDE.md")]);
    expect(result.tier).toBe("high");
    expect(result.reasons).toEqual(["agent instructions or hooks (CLAUDE.md)"]);
  });
});

describe("the floor's tripwires on added lines", () => {
  const changed = (path: string, addedText: string | null) => ({
    path,
    additions: 1,
    deletions: 0,
    addedText,
  });

  it("raises anything that runs a process, in any area", () => {
    for (const [path, text] of [
      ["src/components/Foo.tsx", 'import { spawnSync } from "node:child_process";'],
      ["sidecar/src/memory/recall.ts", "Bun.spawn(['git', 'status'])"],
      ["src-tauri/src/alarms.rs", 'let out = Command::new("say").arg("hi").output();'],
    ] as const) {
      expect(classify([changed(path, text)]).reasons).toEqual([`runs a process (${path})`]);
    }
  });

  it("raises a call to a command that writes a secret or reaches a shell", () => {
    for (const text of [
      'invoke("set_secret", { key, value })',
      'invoke<void>("pty_write", { id, data })',
    ]) {
      expect(classify([changed("src/lib/x.ts", text)]).tier).toBe("high");
    }
  });

  it("raises a change to what runs without asking", () => {
    expect(
      classify([changed("src/lib/x.ts", 'setToolSettings(id, { approval: "auto" })')]).tier,
    ).toBe("high");
  });

  it("puts reading secrets, outside URLs and deletes at standard", () => {
    expect(
      classify([changed("sidecar/src/x.ts", "const t = config.secrets?.githubToken;")]).tier,
    ).toBe("standard");
    expect(classify([changed("src/lib/x.ts", 'fetch("https://api.example.com/v1")')]).tier).toBe(
      "standard",
    );
    expect(classify([changed("sidecar/src/x.ts", "rmSync(dir, { recursive: true })")]).tier).toBe(
      "standard",
    );
  });

  it("leaves a plain UI change low", () => {
    expect(
      classify([changed("src/components/Foo.tsx", '<div className="p-2">{title}</div>')]).tier,
    ).toBe("low");
  });

  it("can't scan a diff GitHub didn't send, so counts it as standard", () => {
    expect(classify([changed("sidecar/src/big.ts", null)]).reasons).toEqual([
      "a diff too big to scan (sidecar/src/big.ts)",
    ]);
  });

  it("skips tests and files that aren't source", () => {
    expect(classify([changed("src/a.test.ts", "Bun.spawn(['x'])")]).tier).toBe("low");
    expect(classify([changed("docs/x.md", "eval(")]).tier).toBe("low");
  });
});

describe("the floor's paths", () => {
  it("covers the files that store secrets, run commands, or decide what runs unasked", () => {
    for (const path of [
      "src-tauri/src/mcp.rs",
      "src-tauri/src/custom_providers.rs",
      "sidecar/src/workspaces/exec.ts",
      "sidecar/src/workspaces/claudeSettings.ts",
      "sidecar/src/chat/toolReview.ts",
      "sidecar/src/telegram/otpGate.ts",
      "sidecar/src/mcp/oauth.ts",
      "sidecar/src/agents/definitions/planner.md",
      "extension/background.js",
      "scripts/browser/host.ts",
    ]) {
      expect(classify([file(path)]).tier).toBe("high");
    }
  });
});
