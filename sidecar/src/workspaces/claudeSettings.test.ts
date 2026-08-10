import { describe, expect, it } from "bun:test";
import { ingestSchema } from "../attention/routes.ts";
import { attentionHookCommand, buildClaudeSettings } from "./claudeSettings.ts";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Pulls the JSON body out of the command's `-d` argument, resolved by a real
 * shell — the body spans several quoted segments around an env expansion, so
 * only a shell can tell us what curl would actually receive.
 */
function payloadOf(command: string, env: Record<string, string> = {}): unknown {
  const match = command.match(/-d (.*) >\/dev\/null/);
  if (!match) throw new Error("no -d payload in command");
  const run = Bun.spawnSync(["sh", "-c", `printf %s ${match[1]}`], {
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return JSON.parse(run.stdout.toString());
}

describe("attentionHookCommand", () => {
  it("emits a body that satisfies the ingest route's schema", () => {
    // The whole feature silently breaks if these two sides drift, so pin them.
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "permission");
    const parsed = ingestSchema.safeParse(payloadOf(command));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionKey: `ws-claude:${WORKSPACE_ID}`,
      kind: "permission",
    });
  });

  it("reports the PTY session it runs in, so the item names the exact tab", () => {
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "permission");
    const payload = payloadOf(command, { YARVIS_SESSION_KEY: `ws:${WORKSPACE_ID}/t1/p2` });
    expect(payload).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionKey: `ws:${WORKSPACE_ID}/t1/p2`,
      kind: "permission",
    });
  });

  it("treats a hostile session key as data, not as shell to run", () => {
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "permission");
    const payload = payloadOf(command, { YARVIS_SESSION_KEY: "$(echo pwned);id" }) as {
      sessionKey: string;
    };
    expect(payload.sessionKey).toBe("$(echo pwned);id");
  });

  it("refuses to embed a value that would be scanned by the shell", () => {
    // The fallback key is spliced into a ${VAR:-word} default, which the shell
    // expands even inside double quotes — so it must be rejected, not escaped.
    expect(() => attentionHookCommand(WORKSPACE_ID, "ws-claude:$(id)", "idle")).toThrow(
      /unsafe value/,
    );
    expect(() => attentionHookCommand("w'1", `ws-claude:${WORKSPACE_ID}`, "idle")).toThrow(
      /unsafe value/,
    );
  });

  it("falls back to the workspace Claude key outside a Yarvis PTY", () => {
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "idle");
    expect(payloadOf(command)).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionKey: `ws-claude:${WORKSPACE_ID}`,
      kind: "idle",
    });
  });

  it("reads the sidecar port + token from the environment, not from disk", () => {
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "idle");
    // Asserting the literal shell env-var references the hook relies on.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env refs, not a template
    expect(command).toContain("${YARVIS_SIDECAR_PORT}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env refs, not a template
    expect(command).toContain("${YARVIS_ATTENTION_TOKEN}");
  });
});

describe("buildClaudeSettings", () => {
  it("writes the three attention hooks with the idle_prompt matcher on Notification", () => {
    const settings = buildClaudeSettings(WORKSPACE_ID) as {
      hooks: Record<string, { matcher?: string }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification",
      "PermissionRequest",
      "Stop",
    ]);
    expect(settings.hooks.Notification![0]!.matcher).toBe("idle_prompt");
    expect(settings.hooks.PermissionRequest![0]!.matcher).toBeUndefined();
  });

  it("preserves unrelated top-level keys and the user's own hooks for our events", () => {
    const existing = {
      permissions: { allow: ["Bash"] },
      hooks: {
        PermissionRequest: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo other-event" }] }],
      },
    };
    const settings = buildClaudeSettings(WORKSPACE_ID, existing) as {
      permissions: unknown;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    // Unrelated top-level key and unrelated hook event both survive.
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    // Our entry is appended alongside the user's own PermissionRequest hook.
    const commands = settings.hooks.PermissionRequest!.flatMap((e) =>
      e.hooks.map((h) => h.command),
    );
    expect(commands).toContain("echo user-hook");
    expect(commands.some((c) => c.includes("/ingest/attention"))).toBe(true);
  });

  it("is idempotent: re-applying does not stack duplicate Yarvis hooks", () => {
    const once = buildClaudeSettings(WORKSPACE_ID);
    const twice = buildClaudeSettings(WORKSPACE_ID, once) as {
      hooks: Record<string, unknown[]>;
    };
    expect(twice.hooks.PermissionRequest).toHaveLength(1);
    expect(twice.hooks.Notification).toHaveLength(1);
    expect(twice.hooks.Stop).toHaveLength(1);
  });

  it("registers skills/agents paths alongside the hooks", () => {
    const settings = buildClaudeSettings(
      WORKSPACE_ID,
      {},
      ["/ws/repo-a/.claude/skills", "/ws/repo-b/.claude/skills"],
      ["/ws/repo-a/.claude/agents"],
    ) as {
      hooks: Record<string, unknown[]>;
      skills: { enabled: boolean; paths: string[] };
      agents: { enabled: boolean; paths: string[] };
    };
    // The hooks are still written; skills/agents are additive keys.
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.skills).toEqual({
      enabled: true,
      paths: ["/ws/repo-a/.claude/skills", "/ws/repo-b/.claude/skills"],
    });
    expect(settings.agents).toEqual({ enabled: true, paths: ["/ws/repo-a/.claude/agents"] });
  });

  it("drops stale skills/agents keys when no paths are given", () => {
    // A prior run left skills/agents; a re-provision that finds none must clear them.
    const prior = buildClaudeSettings(
      WORKSPACE_ID,
      {},
      ["/ws/repo/.claude/skills"],
      ["/ws/repo/.claude/agents"],
    );
    const cleared = buildClaudeSettings(WORKSPACE_ID, prior) as Record<string, unknown>;
    expect(cleared.skills).toBeUndefined();
    expect(cleared.agents).toBeUndefined();
  });
});
