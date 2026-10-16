import { describe, expect, it } from "bun:test";
import { ingestSchema } from "../attention/routes.ts";
import {
  agentSessionHookCommand,
  attentionHookCommand,
  buildClaudeSettings,
} from "./claudeSettings.ts";

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

/** A request the registration hook made, as the sidecar would receive it. */
interface CapturedRequest {
  url: URL;
  headers: Headers;
  body: unknown;
}

/**
 * Runs the registration hook in a real shell against a stand-in sidecar, with
 * `hookInput` on stdin the way Claude Code delivers it.
 */
async function runRegistrationHook(
  env: Record<string, string>,
  hookInput: unknown,
): Promise<{ requests: CapturedRequest[]; shellParent: number }> {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      requests.push({ url: new URL(req.url), headers: req.headers, body: await req.json() });
      return new Response(null, { status: 204 });
    },
  });
  try {
    const run = Bun.spawn(["sh", "-c", agentSessionHookCommand(WORKSPACE_ID)], {
      env: {
        PATH: process.env.PATH ?? "",
        YARVIS_SIDECAR_PORT: String(server.port),
        YARVIS_ATTENTION_TOKEN: "tok",
        ...env,
      },
      stdin: new Blob([JSON.stringify(hookInput)]),
    });
    expect(await run.exited).toBe(0);
    // The shell's parent is this test process, which stands in for Claude.
    return { requests, shellParent: process.pid };
  } finally {
    server.stop(true);
  }
}

describe("agentSessionHookCommand", () => {
  const hookInput = {
    session_id: "d8cb83ea-8ef9-42b0-95b2-bf4602c282bc",
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: "/ws",
  };

  it("forwards Claude's hook input with its pid and the PTY it runs in", async () => {
    const { requests, shellParent } = await runRegistrationHook(
      { YARVIS_SESSION_KEY: `ws-claude:${WORKSPACE_ID}` },
      hookInput,
    );
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req!.url.pathname).toBe("/ingest/agent-session");
    expect(req!.url.searchParams.get("workspaceId")).toBe(WORKSPACE_ID);
    expect(req!.url.searchParams.get("pid")).toBe(String(shellParent));
    expect(req!.headers.get("authorization")).toBe("Bearer tok");
    expect(req!.headers.get("x-yarvis-session-key")).toBe(`ws-claude:${WORKSPACE_ID}`);
    expect(req!.body).toEqual(hookInput);
  });

  it("registers nothing outside a Yarvis PTY", async () => {
    // A headless `claude -p` in the workspace has no prompt to deliver to.
    const { requests } = await runRegistrationHook({}, hookInput);
    expect(requests).toEqual([]);
  });

  it("refuses to embed a workspace id the shell would scan", () => {
    expect(() => agentSessionHookCommand("w$(id)")).toThrow(/unsafe value/);
  });
});

describe("buildClaudeSettings", () => {
  it("writes the attention and registration hooks, with idle_prompt on Notification", () => {
    const settings = buildClaudeSettings(WORKSPACE_ID) as {
      hooks: Record<string, { matcher?: string }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification",
      "PermissionRequest",
      "SessionEnd",
      "SessionStart",
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
    expect(twice.hooks.SessionStart).toHaveLength(1);
    expect(twice.hooks.SessionEnd).toHaveLength(1);
  });

  it("strips the skills/agents paths an earlier version wrote", () => {
    // Claude Code ignores those keys; the repos' skills are copied to the root
    // instead, so leaving the paths behind would only mislead a reader.
    const settings = buildClaudeSettings(WORKSPACE_ID, {
      skills: { enabled: true, paths: ["/ws/repo/.claude/skills"] },
      agents: { enabled: true, paths: ["/ws/repo/.claude/agents"] },
    }) as Record<string, unknown>;
    expect(settings.skills).toEqual({ enabled: true });
    expect(settings.agents).toEqual({ enabled: true });
  });

  it("removes the skills key entirely when paths was all it held", () => {
    const settings = buildClaudeSettings(WORKSPACE_ID, {
      skills: { paths: ["/ws/repo/.claude/skills"] },
    }) as Record<string, unknown>;
    expect(settings.skills).toBeUndefined();
  });

  it("leaves a skills key the user set by hand alone", () => {
    // `enabled` is a real toggle even though `paths` is not.
    const settings = buildClaudeSettings(WORKSPACE_ID, {
      skills: { enabled: false },
    }) as Record<string, unknown>;
    expect(settings.skills).toEqual({ enabled: false });
  });
});
