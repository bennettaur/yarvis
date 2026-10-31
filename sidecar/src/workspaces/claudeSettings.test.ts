import { describe, expect, it } from "bun:test";
import { ingestSchema, PERMISSION_HOLD_MS } from "../attention/routes.ts";
import {
  activityHookCommand,
  agentSessionHookCommand,
  attentionHookCommand,
  buildClaudeSettings,
  PERMISSION_HOOK_TIMEOUT_S,
  permissionHookCommand,
  permissionSettledHookCommand,
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
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "idle");
    const parsed = ingestSchema.safeParse(payloadOf(command));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionKey: `ws-claude:${WORKSPACE_ID}`,
      kind: "idle",
    });
  });

  it("reports the PTY session it runs in, so the item names the exact tab", () => {
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "idle");
    const payload = payloadOf(command, { YARVIS_SESSION_KEY: `ws:${WORKSPACE_ID}/t1/p2` });
    expect(payload).toEqual({
      workspaceId: WORKSPACE_ID,
      sessionKey: `ws:${WORKSPACE_ID}/t1/p2`,
      kind: "idle",
    });
  });

  it("treats a hostile session key as data, not as shell to run", () => {
    const command = attentionHookCommand(WORKSPACE_ID, `ws-claude:${WORKSPACE_ID}`, "idle");
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

describe("permissionHookCommand", () => {
  /** Runs the command under a real shell against a stand-in sidecar. */
  async function runAgainst(
    reply: (req: Request) => Response | Promise<Response>,
    stdin: string,
    env: Record<string, string> = {},
  ) {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: reply });
    try {
      const child = Bun.spawn(["sh", "-c", permissionHookCommand(WORKSPACE_ID)], {
        env: {
          PATH: process.env.PATH ?? "",
          YARVIS_SIDECAR_PORT: String(server.port),
          YARVIS_ATTENTION_TOKEN: "scoped",
          YARVIS_SESSION_KEY: `ws:${WORKSPACE_ID}/t1/p1`,
          YARVIS_SESSION_TOKEN: "pty-token",
          ...env,
        },
        stdin: new Blob([stdin]),
        stdout: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      return { stdout, exitCode: await child.exited };
    } finally {
      server.stop(true);
    }
  }

  it("forwards Claude Code's stdin with the session's identity and prints the decision", async () => {
    let seen: { headers: Headers; body: unknown } | null = null;
    const decision = { hookSpecificOutput: { decision: { behavior: "allow" } } };
    const { stdout, exitCode } = await runAgainst(
      async (req) => {
        seen = { headers: req.headers, body: await req.json() };
        return Response.json(decision);
      },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(decision);
    expect(seen!.body).toEqual({ tool_name: "Bash", tool_input: { command: "ls" } });
    expect(seen!.headers.get("authorization")).toBe("Bearer scoped");
    expect(seen!.headers.get("x-yarvis-workspace-id")).toBe(WORKSPACE_ID);
    expect(seen!.headers.get("x-yarvis-session-key")).toBe(`ws:${WORKSPACE_ID}/t1/p1`);
    expect(seen!.headers.get("x-yarvis-session-token")).toBe("pty-token");
  });

  it("prints nothing and exits cleanly when the sidecar refuses", async () => {
    // An error body on stdout would read to Claude Code as a malformed decision.
    const { stdout, exitCode } = await runAgainst(
      () => Response.json({ error: "nope" }, { status: 401 }),
      "{}",
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  for (const unset of ["YARVIS_SIDECAR_PORT", "YARVIS_SESSION_KEY", "YARVIS_SESSION_TOKEN"]) {
    it(`prints nothing without ${unset}, without calling anything`, async () => {
      let called = false;
      const { stdout, exitCode } = await runAgainst(
        () => {
          called = true;
          return Response.json({ hookSpecificOutput: { decision: { behavior: "allow" } } });
        },
        "{}",
        { [unset]: "" },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(called).toBe(false);
    });
  }

  it("stays inside Claude Code's timeout for the hook", () => {
    const command = permissionHookCommand(WORKSPACE_ID);
    const maxTime = Number(command.match(/-m (\d+)/)?.[1]);
    expect(maxTime).toBeLessThan(PERMISSION_HOOK_TIMEOUT_S);
  });

  it("ends the sidecar's hold before curl gives up", () => {
    const command = permissionHookCommand(WORKSPACE_ID);
    const maxTime = Number(command.match(/-m (\d+)/)?.[1]);
    expect(PERMISSION_HOLD_MS / 1000).toBeLessThan(maxTime);
    // setTimeout fires at once for anything longer.
    expect(PERMISSION_HOLD_MS).toBeLessThanOrEqual(2 ** 31 - 1);
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
        YARVIS_SESSION_TOKEN: "session-tok",
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
    expect(req!.headers.get("x-yarvis-session-token")).toBe("session-tok");
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

describe("activityHookCommand", () => {
  const hookInput = {
    session_id: "d8cb83ea-8ef9-42b0-95b2-bf4602c282bc",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  };

  async function runActivityHook(env: Record<string, string>): Promise<CapturedRequest[]> {
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
      const run = Bun.spawn(["sh", "-c", activityHookCommand(WORKSPACE_ID)], {
        env: {
          PATH: process.env.PATH ?? "",
          YARVIS_SIDECAR_PORT: String(server.port),
          YARVIS_ATTENTION_TOKEN: "tok",
          ...env,
        },
        stdin: new Blob([JSON.stringify(hookInput)]),
        stdout: "pipe",
      });
      expect(await run.exited).toBe(0);
      // Async hook output is ignored by Claude Code, but it must stay empty anyway.
      expect(await new Response(run.stdout).text()).toBe("");
      return requests;
    } finally {
      server.stop(true);
    }
  }

  it("forwards Claude's hook input with the workspace and the PTY's session headers", async () => {
    const requests = await runActivityHook({
      YARVIS_SESSION_KEY: `ws-claude:${WORKSPACE_ID}`,
      YARVIS_SESSION_TOKEN: "session-tok",
    });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req!.url.pathname).toBe("/ingest/activity");
    expect(req!.url.searchParams.get("workspaceId")).toBe(WORKSPACE_ID);
    expect(req!.headers.get("authorization")).toBe("Bearer tok");
    expect(req!.headers.get("x-yarvis-session-key")).toBe(`ws-claude:${WORKSPACE_ID}`);
    expect(req!.headers.get("x-yarvis-session-token")).toBe("session-tok");
    expect(req!.body).toEqual(hookInput);
  });

  it("sends nothing outside a Yarvis PTY", async () => {
    expect(await runActivityHook({})).toEqual([]);
  });

  it("refuses to embed a workspace id the shell would scan", () => {
    expect(() => activityHookCommand("w$(id)")).toThrow(/unsafe value/);
  });
});

describe("buildClaudeSettings", () => {
  it("writes the attention, settle and registration hooks, with idle_prompt on Notification", () => {
    const settings = buildClaudeSettings(WORKSPACE_ID) as {
      hooks: Record<string, { matcher?: string }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
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
    // An unrelated top-level key survives, and the user's own UserPromptSubmit
    // hook stays beside ours.
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    // Our entry is appended alongside the user's own PermissionRequest hook.
    const commands = settings.hooks.PermissionRequest!.flatMap((e) =>
      e.hooks.map((h) => h.command),
    );
    expect(commands).toContain("echo user-hook");
    expect(commands.some((c) => c.includes("/ingest/permission"))).toBe(true);
  });

  it("replaces the flag-only permission hook an earlier version wrote", () => {
    const existing = {
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              {
                type: "command",
                // What an earlier version wrote: a flag-only post to the attention ingest.
                command: `cat >/dev/null 2>&1; curl -sf -m 5 -X POST "http://127.0.0.1:\${YARVIS_SIDECAR_PORT}/ingest/attention" -d '{"workspaceId":"${WORKSPACE_ID}","kind":"permission"}' || true`,
              },
            ],
          },
        ],
      },
    };
    const settings = buildClaudeSettings(WORKSPACE_ID, existing) as {
      hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
    };
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    const [hook] = settings.hooks.PermissionRequest![0]!.hooks;
    expect(hook!.command).toContain("/ingest/permission");
    expect(hook!.timeout).toBe(PERMISSION_HOOK_TIMEOUT_S);
  });

  it("is idempotent: re-applying does not stack duplicate Yarvis hooks", () => {
    const once = buildClaudeSettings(WORKSPACE_ID);
    const twice = buildClaudeSettings(WORKSPACE_ID, once) as {
      hooks: Record<string, unknown[]>;
    };
    expect(twice.hooks.PermissionRequest).toHaveLength(1);
    // The idle_prompt entry and the activity entry.
    expect(twice.hooks.Notification).toHaveLength(2);
    expect(twice.hooks.Stop).toHaveLength(1);
    expect(twice.hooks.PostToolUse).toHaveLength(1);
    expect(twice.hooks.UserPromptSubmit).toHaveLength(1);
    expect(twice.hooks.SessionStart).toHaveLength(1);
    expect(twice.hooks.SessionEnd).toHaveLength(1);
    expect(twice.hooks.PreToolUse).toHaveLength(1);
    expect(twice.hooks.PostToolUseFailure).toHaveLength(1);
    expect(twice.hooks.SubagentStop).toHaveLength(1);
    expect(twice.hooks.PreCompact).toHaveLength(1);
  });

  it("reports activity on every event the Agent Field page draws, without waiting", () => {
    const settings = buildClaudeSettings(WORKSPACE_ID) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string; async?: boolean }[] }[]>;
    };
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUseFailure",
      "SubagentStop",
      "Stop",
      "Notification",
      "PreCompact",
    ]) {
      const entries = settings.hooks[event]!.filter((e) =>
        e.hooks.some((h) => h.command.includes("/ingest/activity")),
      );
      expect(entries).toHaveLength(1);
      // Every notification, not just the idle one the attention hook matches.
      expect(entries[0]!.matcher).toBeUndefined();
      const hook = entries[0]!.hooks.find((h) => h.command.includes("/ingest/activity"));
      expect(hook?.async).toBe(true);
    }
  });

  it("settles held prompts after every tool call and at the end of a turn, without waiting", () => {
    const settings = buildClaudeSettings(WORKSPACE_ID) as {
      hooks: Record<string, { hooks: { command: string; async?: boolean }[] }[]>;
    };
    for (const event of ["PostToolUse", "Stop", "UserPromptSubmit"]) {
      const hooks = settings.hooks[event]!.flatMap((e) => e.hooks);
      const settle = hooks.find((h) => h.command.includes("/ingest/permission/settled"));
      expect(settle?.async).toBe(true);
    }
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

describe("sandbox paths", () => {
  const GIT = "/ws/.repos/acme-api/.git";
  const REPO = { clonePath: "/ws/.repos/acme-api", branch: "yarvis/fix-it", adminName: "api" };
  type Filesystem = { allowWrite?: unknown[]; denyWrite?: unknown[]; denyRead?: string[] };
  type WithSandbox = { sandbox?: { enabled?: boolean; filesystem?: Filesystem } };
  const filesystemOf = (settings: Record<string, unknown>) =>
    (settings as WithSandbox).sandbox?.filesystem;

  it("lets the sandbox commit to this workspace's branch and worktree, and nothing else's", () => {
    expect(filesystemOf(buildClaudeSettings(WORKSPACE_ID, {}, [REPO]))?.allowWrite).toEqual([
      `${GIT}/objects`,
      `${GIT}/refs/heads/yarvis/fix-it`,
      `${GIT}/refs/heads/yarvis/fix-it.lock`,
      `${GIT}/logs/refs/heads/yarvis/fix-it`,
      `${GIT}/refs/remotes/origin/yarvis/fix-it`,
      `${GIT}/refs/remotes/origin/yarvis/fix-it.lock`,
      `${GIT}/logs/refs/remotes/origin/yarvis/fix-it`,
      `${GIT}/worktrees/api`,
    ]);
  });

  it("keeps what decides what git runs, or what other workspaces see, out of reach", () => {
    // Tags among them: git resolves `origin/main` to a tag of that name before
    // the remote-tracking ref.
    expect(filesystemOf(buildClaudeSettings(WORKSPACE_ID, {}, [REPO]))?.denyWrite).toEqual([
      `${GIT}/config`,
      `${GIT}/config.lock`,
      `${GIT}/hooks`,
      `${GIT}/commondir`,
      `${GIT}/modules`,
      `${GIT}/info`,
      `${GIT}/refs/replace`,
      `${GIT}/refs/tags`,
      `${GIT}/objects/info`,
      `${GIT}/packed-refs`,
      `${GIT}/packed-refs.lock`,
      `${GIT}/worktrees/api/commondir`,
      `${GIT}/worktrees/api/gitdir`,
      `${GIT}/worktrees/api/config.worktree`,
      `${GIT}/worktrees/api/modules`,
    ]);
  });

  it("grants no worktree or branch it can't place safely", () => {
    const fs = filesystemOf(
      buildClaudeSettings(WORKSPACE_ID, {}, [{ ...REPO, branch: "../../config", adminName: null }]),
    );
    expect(fs?.allowWrite).toEqual([`${GIT}/objects`]);
  });

  it("keeps the user's own sandbox settings and paths", () => {
    const fs = filesystemOf(
      buildClaudeSettings(
        WORKSPACE_ID,
        {
          sandbox: {
            enabled: true,
            filesystem: {
              allowWrite: ["~/scratch", "/ws/.repos/notes.txt"],
              denyWrite: ["~/scratch/keep"],
              denyRead: ["~/secrets"],
            },
          },
        },
        [REPO],
      ),
    );
    expect(fs?.denyRead).toEqual(["~/secrets"]);
    expect(fs?.allowWrite?.slice(0, 2)).toEqual(["~/scratch", "/ws/.repos/notes.txt"]);
    expect(fs?.denyWrite?.[0]).toBe("~/scratch/keep");
  });

  it("replaces its own paths, including an earlier version's, and drops a repo that left", () => {
    const earlier = {
      sandbox: {
        filesystem: {
          allowWrite: [`${GIT}`, "/ws/.repos/acme-api/.claude/worktrees", "/ws/.repos-backup/x"],
        },
      },
    };
    const before = buildClaudeSettings(WORKSPACE_ID, earlier, [
      REPO,
      { clonePath: "/ws/.repos/acme-web", branch: "main", adminName: "web" },
    ]);
    const after = filesystemOf(buildClaudeSettings(WORKSPACE_ID, before, [REPO]));
    expect(after?.allowWrite).toEqual([
      "/ws/.repos-backup/x",
      ...(filesystemOf(buildClaudeSettings(WORKSPACE_ID, {}, [REPO]))?.allowWrite ?? []),
    ]);
    expect(after?.denyWrite).toEqual(
      filesystemOf(buildClaudeSettings(WORKSPACE_ID, {}, [REPO]))?.denyWrite,
    );
  });

  it("clears its paths when the workspace's last repo has gone", () => {
    const before = buildClaudeSettings(WORKSPACE_ID, {}, [REPO]);
    const after = filesystemOf(buildClaudeSettings(WORKSPACE_ID, before, []));
    expect(after?.allowWrite).toEqual([]);
    expect(after?.denyWrite).toEqual([]);
  });

  it("adds no sandbox settings to a workspace that never had repos", () => {
    expect((buildClaudeSettings(WORKSPACE_ID) as WithSandbox).sandbox).toBeUndefined();
  });
});

describe("permissionSettledHookCommand", () => {
  async function run(reply: (req: Request) => Response | Promise<Response>, stdin: string) {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: reply });
    try {
      const child = Bun.spawn(["sh", "-c", permissionSettledHookCommand(WORKSPACE_ID)], {
        env: {
          PATH: process.env.PATH ?? "",
          YARVIS_SIDECAR_PORT: String(server.port),
          YARVIS_ATTENTION_TOKEN: "scoped",
          YARVIS_SESSION_KEY: `ws:${WORKSPACE_ID}/t1/p1`,
          YARVIS_SESSION_TOKEN: "pty-token",
        },
        stdin: new Blob([stdin]),
        stdout: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      return { stdout, exitCode: await child.exited };
    } finally {
      server.stop(true);
    }
  }

  it("forwards the hook's stdin with the session's identity and prints nothing", async () => {
    // UserPromptSubmit output becomes part of Claude's context, so even a reply
    // body must not reach stdout.
    let seen: { headers: Headers; body: unknown; path: string } | null = null;
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    const { stdout, exitCode } = await run(async (req) => {
      seen = { headers: req.headers, body: await req.json(), path: new URL(req.url).pathname };
      return Response.json({ note: "should not be printed" });
    }, JSON.stringify(input));
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(seen!.path).toBe("/ingest/permission/settled");
    expect(seen!.body).toEqual(input);
    expect(seen!.headers.get("x-yarvis-session-key")).toBe(`ws:${WORKSPACE_ID}/t1/p1`);
    expect(seen!.headers.get("x-yarvis-session-token")).toBe("pty-token");
  });

  it("does nothing outside a Yarvis terminal", () => {
    const run = Bun.spawnSync(["sh", "-c", permissionSettledHookCommand(WORKSPACE_ID)], {
      env: { PATH: process.env.PATH ?? "" },
      stdin: new Blob(["{}"]),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
  });
});
