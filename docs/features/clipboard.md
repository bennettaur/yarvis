# Clipboard

Referencing something from Yarvis elsewhere (in Slack, a ticket, or an agent
prompt) shouldn't mean opening a browser to find the link first. So the things
worth quoting carry a **copy button**. For text you paste again and again, the
**clipboard palette** keeps saved snippets and this session's clipboard
history one shortcut away.

There is nothing to set up.

## Use it

### Copy buttons

You'll find copy buttons next to:

- **In a workspace:**
  - the workspace folder,
  - each repo's worktree path, and the picked one when the column shows
    another worktree,
  - the PR link, on the status line and in the PR checks view,
  - the PR checks view's check summary,
  - both file lists: one row's full path, or the whole list, one path per line.
- **In a PR review:**
  - the provider's link to the PR,
  - the link to each file, pinned to the commit the PR points at, so it still
    shows the code you meant after a later push,
  - the link to each check, and every check at once, one per line.
- **On an issue:** its GitHub or JIRA link.

Where a link can't be worked out, no button appears.

### The clipboard palette

1. Press **Control+Shift+V** from anywhere, or click the clipboard icon in
   the nav rail.
2. Type to search.
3. Move with the arrow keys, and press **Enter** to copy the highlighted row
   and close the palette. **Esc** closes it without copying.

The palette has two tabs:

- **Saved.** The things you copy again and again: a user id, a CLI
  command, a link. Entries can be labeled, tagged and pinned. Pinned entries
  sort first, then whatever you copied most recently, so an empty search
  already offers what you usually want.
- **History.** What passed through your clipboard during this run of the app.
  It sits on its own tab so a long saved list never pushes it out of view.

To keep a clip from History, press **Save** on it. It becomes a permanent
Saved entry. **Clear history** forgets everything recorded so far.

History is never written to disk. It lives in memory in the Rust core, holds
the last 100 clips, and is gone when the app quits.

## This is not a secret store

Saving an entry is refused when the text looks like a credential. That
includes:

- provider token prefixes (GitHub, AWS, Slack, Google, Stripe, npm, `sk-…` API
  keys),
- PEM private-key blocks,
- JWTs,
- URLs with an embedded password,
- inline `password=` or `api_key=` assignments,
- long, high-entropy tokens.

Clipboard history is screened with the same patterns. A password that passed
through your clipboard is left out of the palette rather than listed. The
footer says how many clips were hidden.

Detection is a heuristic, so it errs toward refusing. Identifiers the palette
exists to hold are deliberately allowed: UUIDs, hex digests, plain URLs, and
commands whose secret is a `$VAR` reference. A base64 blob may well be refused.

Secrets belong in the Keychain, entered under **Settings → Credentials**. See
[Configuration](../configuration.md#secrets).

## How copied text is cleaned

Anything a provider supplies is cleaned before it reaches your clipboard:

- Control and formatting characters are stripped from each field before lines
  are joined. A filename or check name carrying a newline can't forge a line of
  its own in what you paste.
- A link is copied only if Yarvis would open it: the same http(s) rule the
  **Open ↗** buttons use.
- A file link whose path has `.` or `..` segments is refused. Git never stores
  such a path, and a browser would resolve those segments away, landing the
  reader somewhere other than the repo the link appears to name.

See [Keyboard shortcuts](keyboard-shortcuts.md) for the palette's hotkey and
the others.
