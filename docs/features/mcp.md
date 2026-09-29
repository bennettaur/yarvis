# MCP

Yarvis speaks the [Model Context Protocol](https://modelcontextprotocol.io) in
both directions. It connects **out** to MCP servers you add, so the assistant
can use their tools. It also **serves** its own MCP endpoint, so Claude Code
and other clients can read and write Yarvis's memory. The second is what lets a
coding session look up what you told Yarvis last week and write back what it
learned.

## Connecting MCP servers to Yarvis

### Set up

Add servers under **Settings → Tools & MCP → MCP servers**. A server is one of
two kinds:

- **Remote.** Streamable HTTP or SSE, given a URL.
- **Local.** A stdio subprocess, given a command and arguments.

The server's structure is saved in `~/.yarvis/settings.json`. Its credentials
go to the Keychain.

1. Add the server and save it.
2. If it needs authentication, set that up (see below).
3. Press **Connect**. Yarvis attaches and pulls the server's tools into its
   tool registry.
4. Open the **Tool manager** on the same screen and decide how each tool is
   offered to the assistant (see [Use it](#use-it)).

### Authenticate a remote server

A remote server authenticates one of two ways.

**Auth headers.**

1. Name the headers on the server, for example `X-API-Key`, and save.
2. Fill in each header's value.

Values are stored in the Keychain. They take effect after the sidecar
restarts, which Yarvis does for you.

**Sign in with OAuth.**

1. Tick **Sign in with OAuth** on a remote server.
2. Press **Authorize**. Your browser opens to the server's consent page.
3. Approve. The tokens come back to a loopback redirect and are stored in the
   Keychain. They refresh on their own while the app runs.

Behind the scenes, Yarvis runs the MCP authorization flow: it finds the
server's authorization server and registers itself as a public client, using
dynamic client registration and PKCE.

About the **Scopes** field:

- Leave it blank and Yarvis reads the scopes from the server's
  protected-resource metadata (`scopes_supported`) and requests those.
- Yarvis fills the scopes in because a token with no scopes is still valid. A
  server that needs a scope would then fail every tool call instead of the
  sign-in, with a confusing protocol error rather than "missing scope".
- Set it explicitly to ask for fewer scopes than the server advertises. That is
  worth doing when it lists identity scopes (`openid`, `profile`, `email`) the
  tools don't need.
- Include `offline_access` if the server wants it before it issues a refresh
  token.
- Changing the scopes re-registers the client, so you authorize again.

The redirect Yarvis registers is
`http://127.0.0.1:<sidecar-port>/oauth/mcp/callback`. The port is picked fresh
at each app launch, so the registration is redone after a restart. There is
nothing to configure, but the first Connect after a relaunch may ask you to
sign in again.

**Sign out** forgets both the tokens and the registration.

The two methods combine. An OAuth server can still carry extra headers, a
tenant id for example, alongside its bearer token. `Authorization` is reserved
and can't be a custom header on either kind.

### Use it

The Tool manager sets two things per tool.

How the tool is offered:

- **Always.** Kept in the assistant's context on every turn.
- **Search.** Found on demand. The assistant searches for it and mounts it when
  a turn needs it.
- **Disabled.** Hidden from the assistant.

Whether it needs approval:

- **Ask** (the default). Each call raises the approval bar above the chat's
  message box. It shows the call at the front of the queue and how many are
  waiting. **Approve** (`A`) and **Deny** (`D`) answer it, and **Arguments**
  shows what the tool was called with.
- **Auto.** Runs without asking. **Always allow** on the approval bar sets
  this for that tool. A group-level button auto-approves, or asks for, every
  tool on a server.

A denied call is not retried or worked around.

Your consent is for the tool as it was described. If a resync finds a tool's
description or schema changed, its approval resets to **Ask**.

Two cases where MCP tools behave differently:

- **Spoken turns.** A turn that came from the microphone ignores Auto and asks
  for every MCP tool, because a transcript was never proofread. See
  [Voice](voice.md).
- **Delegated runs.** Specialists and scheduled Yarvis jobs get no MCP tools at
  all. They have no way to hold an approval prompt open. See
  [The assistant](assistant.md).

### When a connection fails

The server's card shows the reason. The sidecar log (**Settings →
Diagnostics**) has the full version: status, URL and response body.

If a server's replies don't match the MCP schema and the error alone doesn't
explain why, start the app with `YARVIS_DEBUG_MCP=1` to log what the server
actually sent:

```bash
YARVIS_DEBUG_MCP=1 bun run tauri dev
```

## Yarvis as an MCP server

Yarvis serves an MCP endpoint that exposes its memory tools over the same
pgvector store the in-app chat uses:

| Tool | What it does |
| --- | --- |
| `recall` | Searches memory by meaning |
| `remember` | Stores a durable fact |
| `take_note` | Stores a quick note, which feeds the daily and weekly recaps |
| `list_memories` | Lists memories, newest first, optionally by `kind` (`fact`, `note`, `session-summary`, …) |
| `forget` | Deletes a memory |

Not exposed, on purpose:

- **The assistant's own todo list.** A coding session can read and write the
  shared memory, but editing the in-app assistant's plan would be one agent
  rewriting another's.
- **Projects.** These are in-app only too.

### Sessions Yarvis launches need no setup

When Yarvis provisions a workspace, it writes a `.mcp.json` at the workspace
root. That file points at `${YARVIS_SIDECAR_PORT}` with an
`Authorization: Bearer ${YARVIS_MCP_TOKEN}` header. The Rust core puts both
variables into the session's shell, so the file on disk holds no secret.

Claude Code asks you to approve the project's MCP server the first time it sees
it.

Two caveats:

- A workspace created by an older version of Yarvis gets the file the next
  time it is provisioned.
- Only sessions the app can navigate to get the variables: a workspace's agent
  session, and workspace or Terminal-tab panes. These are the same sessions
  that can raise an attention item.

See [Workspaces](workspaces.md).

### Other clients

Claude Code in a terminal Yarvis didn't start, or any other MCP client, needs
pointing by hand.

1. Open **Settings → Tools & MCP → Yarvis MCP endpoint**. It shows the URL and
   token.
2. Press **Copy claude mcp add command**. It copies a command like:
   ```bash
   claude mcp add --transport http yarvis http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
   ```
3. Run it in your terminal.

The command puts the token in your shell history, and Claude Code saves it in
`~/.claude.json`. That exposure is limited: the token only grants the memory
tools, and it changes every time Yarvis relaunches.

The port and token are made once per app launch. Restarting the sidecar (which
saving a secret does) keeps them. Relaunching Yarvis picks new ones, so copy
the command again after a relaunch.

Against a standalone sidecar (`bun run sidecar:dev`), the token is generated
and never printed. Set `YARVIS_MCP_TOKEN` yourself to point a client at one.

### Security

- The endpoint is `POST http://127.0.0.1:<sidecar port>/mcp`.
- It uses a **scoped token** that grants the memory tools and nothing else. The
  rest of the sidecar API keeps its own bearer token.
- It checks the `Host` header. A web page that points a name it controls at
  127.0.0.1 can't reach it.
- Memory contents are treated as untrusted data on the way out. `recall` and
  `list_memories` wrap each result in tags that carry a per-request nonce, and
  name that nonce in the warning that comes with them. Content that writes its
  own closing tag can't end the block and give the calling agent instructions.
- Memories written through this endpoint are stamped `source: "mcp"` and
  reported that way, so a reading agent can tell what it wrote itself from
  what you said.
