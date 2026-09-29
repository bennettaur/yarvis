# Terminals

The **Terminal** tab (Cmd+3) is a full terminal inside Yarvis, with tabs and
split panes. It uses the same terminal as each workspace's tabs. Shells run in
the Rust core, not in the window, so they keep running when you switch to
another part of the app. A Claude Code run started in one of these terminals
can use Yarvis memory and can flag you in the attention bell (the bell in the
top bar that lists sessions waiting on you; see
[Workspaces](workspaces.md#the-attention-bell)).

## Use it

### Tabs

- **New tab:** press **+** or Cmd+T. New tabs are named "Terminal 1",
  "Terminal 2", and so on.
- **Reorder:** drag a tab along the strip.
- **Close:** press × or Cmd+W. If a process is still running in any of the
  tab's panes, you're asked before it is killed.
- Closing the last tab opens a fresh one.

### Split panes

- **Cmd+D** adds a pane to the right.
- **Cmd+Shift+D** adds a pane below.
- Drag a divider to resize. The sizes are saved.
- Hover a pane and press its × to close it. You're asked first if it has a
  running process. Closing a tab's last pane closes the tab.
- In a split, the focused pane has an indigo ring and the others are dimmed.

These shortcuts use Cmd only. Ctrl+D, Ctrl+T and Ctrl+W still go to the shell,
so `Ctrl+D` to exit and similar work as usual.

### Keys

- **Shift+Enter** inserts a newline in Claude Code instead of submitting.
- App shortcuts like Cmd+1–9 and Cmd+/ still work while a terminal has focus.
  See [Keyboard shortcuts](keyboard-shortcuts.md).

## What persists

- **Across tab switches:** everything. The shell keeps running in the Rust
  core. When you come back, up to 1 MiB of scrollback is replayed.
- **Across an app restart:** the layout only. Your tabs, splits and the focused
  pane come back, but each pane gets a new, empty shell. Shells end when the
  app quits.
- New shells in the Terminal tab start in your home folder.

## Session limit

At most 60 terminal sessions can be live at once. This counts every pane in
the Terminal tab and in every workspace. Past the limit, opening another fails
with "too many PTY sessions (cap: N); close one before opening another".

Change the limit under **Settings → Repositories → Terminals → Session limit**,
up to 1000. Each session is a real shell, so the limit trades memory and
process count for how many workspaces you can keep open. Leave the field blank
for the default. A change applies to the next terminal you open, with no
restart. It is stored as `maxPtySessions` in `~/.yarvis/settings.json` (see
[Configuration](../configuration.md)).

## How it relates to workspace terminals

The Terminal tab and each workspace use the same component, each with its own
saved layout. The differences:

- A workspace always has its **agent tab** pinned at the front of the strip. It
  can't be split or dragged, and closing it ends the Claude Code session. See
  [Workspaces](workspaces.md#the-agent-tab).
- Workspace tabs can also hold diffs, the file editor and setup logs.
- Workspace shells start in the workspace folder. Terminal tab shells start in
  your home folder.

An [Omni view](omni-view.md) canvas can also hold a Terminal widget. Those
terminals don't raise attention items.

## Attention and Yarvis memory

Terminals in the Terminal tab and in workspaces get a few environment
variables:

| Variable | What it's for |
| --- | --- |
| `YARVIS_SESSION_KEY` | Names this exact terminal, so an attention item jumps back to it |
| `YARVIS_WORKSPACE_ID` | The workspace it belongs to (workspace terminals only) |
| `YARVIS_ATTENTION_TOKEN` | Lets hooks in this terminal raise attention items, and nothing else |
| `YARVIS_SIDECAR_PORT`, `YARVIS_MCP_TOKEN` | Let a Claude Code session here reach Yarvis's MCP endpoint and its memory tools |

What this gives you:

- **A flagged tab shows an amber ●** with the tooltip "needs you". Opening the
  attention item switches to that exact tab and pane. Looking at the pane
  clears it. See [Workspaces](workspaces.md#the-attention-bell).
- **Claude Code runs here share Yarvis memory.** In a workspace, the `.mcp.json`
  Yarvis writes points at the endpoint. For the Terminal tab, or any other
  client, see [MCP](mcp.md).

## Known gap

When a shell exits, the pane shows "[process exited]" and has no restart
button. Close the pane (or the tab) and open a new one.
