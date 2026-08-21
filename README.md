# Yarvis

A personal-assistant desktop app for macOS, built with Tauri v2.

V1 focuses on the foundation plus an LLM chat interface with memory and
daily/weekly work tracking. See the roadmap in
`~/.claude/plans/we-are-going-to-polymorphic-lightning.md` for the full plan.

## Architecture

Three processes with a clean ownership split:

- **Rust core** (`src-tauri/`) — native OS integration (window, tray,
  notifications), secret storage in the macOS Keychain, and supervision of the
  sidecar process (it picks a free loopback port, generates a bearer token, and
  injects secrets as environment variables).
- **React frontend** (`src/`) — Vite + TypeScript + Tailwind. Talks to the Rust
  core via `invoke` (native + secrets) and to the sidecar over authenticated
  loopback HTTP (data + AI).
- **Bun sidecar** (`sidecar/`) — a Hono HTTP service that owns Postgres access
  (Drizzle ORM), LLM calls, and memory. It also hosts an optional **Telegram
  remote-control bot** (a long-poll loop that drives the same chat agent). Runs
  `src/server.ts` directly with Bun in development; compiled to a single binary
  for distribution.

Data lives in a local **PostgreSQL + pgvector**.

## Installing a nightly build

Nightly `.dmg`s are published to the [`nightly`
release](https://github.com/bennettaur/yarvis/releases/tag/nightly). macOS
quarantines anything downloaded from the internet, and Gatekeeper refuses to
launch a quarantined app that Apple has not notarized. Nightlies are ad-hoc
code-signed but **not notarized**, so the first launch is blocked:

1. Drag **Yarvis** into `/Applications` and try to open it — macOS refuses.
2. Open **System Settings → Privacy & Security**, find the message about Yarvis
   near the bottom, and click **Open Anyway**.

That approves this one app while leaving quarantine — and the XProtect malware
scan that comes with it — in place for everything else. Stripping the flag with
`xattr -dr com.apple.quarantine /Applications/Yarvis.app` also works, but it
skips those checks permanently for the bundle, so prefer **Open Anyway**.

An app with *no* signature at all is rejected differently: macOS reports it as
damaged and offers only to move it to the trash, with no override. That was
[issue #189](https://github.com/bennettaur/yarvis/issues/189) — nightly builds
went out unsigned — and it is what the ad-hoc signing fixes.

Nightly builds still need the [prerequisites](#prerequisites) below at runtime:
PostgreSQL with `pgvector`, plus the secrets entered in Settings.

Notarizing removes the extra step entirely. It needs an Apple Developer account;
once one exists, set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` as
repository secrets and the nightly workflow signs and notarizes without further
changes.

## Prerequisites

- [Bun](https://bun.com) (`bun --version`)
- [Rust](https://rustup.rs) toolchain — `cargo`, `rustc` (required to build the
  Tauri core)
- Xcode Command Line Tools (`xcode-select --install`)
- PostgreSQL with the `pgvector` extension available
- [uv](https://docs.astral.sh/uv/) — only for the local speech server behind the
  Voice feature; skip it if you are not using voice

## Setup

```bash
# 1. Install JS dependencies (root + sidecar workspace)
bun install

# 2. Create the database and enable pgvector
createdb yarvis
psql -d yarvis -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. (Optional) Apply migrations manually. The sidecar also applies any pending
#    migrations automatically on startup, so this is only needed to migrate
#    without launching the app.
DATABASE_URL="postgres://localhost:5432/yarvis" bun run --cwd sidecar db:migrate
```

Secrets are entered in the app's **Settings** screen and stored in the macOS
Keychain — not in env files: the database URL, provider keys (Anthropic,
Gemini, Cerebras), a GitHub token and/or an Azure DevOps token + organization URL (for the
PR dashboard + embedded review — either provider can back it, selected with a
toggle in the PRs tab), a JIRA base URL + account email + API token (for the JIRA
issues integration on the Issues tab), a Google Cloud OAuth client id/secret (for the Calendar
integration), an optional Hugging Face token (for speech-to-text; see
Settings → Voice), an optional embeddings-provider secret (an API key and/or
custom header values for an OpenAI-compatible embeddings endpoint), and an
optional Telegram bot token + allowed chat-id list (and, when the optional second
factor is enabled, a TOTP secret + re-auth window) for the remote-control bot,
see below. AWS Bedrock uses the standard AWS credential chain.

The GitHub token needs `repo` on a classic PAT; on a fine-grained one, **Contents:
Read** (the review reads file bodies and directories to show context around a
change) alongside pull-request and issue access.

The Azure DevOps token is a Personal Access Token with **Code (read)** and
**Pull Request Threads (read & write)** scopes; the organization URL is the
`https://dev.azure.com/your-org` base (project is chosen per search). Azure code
search runs against the separate `almsearch.dev.azure.com` service, provided by
the **Code Search** extension — without it installed, guided review and line
insights still work, the agent just can't search the repo and says so.

The JIRA credentials are for Atlassian Cloud: the base URL is your
`https://your-org.atlassian.net` site, and the API token (created at
id.atlassian.com → Security → API tokens) is paired with your account email for
Basic auth.

Cerebras takes only an API key, created in the Cerebras Cloud console. Unlike a
custom provider, its endpoint is fixed — Cerebras serves the OpenAI
`/chat/completions` shape, so Yarvis talks to it through the OpenAI client
rather than a separate SDK, and there is no base URL to configure.

### Voice

Talk to the assistant and hear it answer. The microphone lives on the Chat tab
and in Omni Chat, so a spoken turn goes to whatever model that chat is already
using, in the same session, and shows up in the transcript labelled `spoken`.

#### Quick start

Speech runs on your own machine — no key, no cloud. On Apple Silicon:

```bash
uv sync                                            # installs the speech server
uv run mlx_audio.server --host 127.0.0.1 --port 8000
```

Leave that running, then in the app:

1. **Settings → LLM Providers → Add** a provider named e.g. `local speech`, base
   URL `http://127.0.0.1:8000/v1`, API kind `openai`. (Put anything in Models —
   the field needs one entry to save; speech models are named separately.)
2. **Settings → Voice** — set both halves to that provider:
   - Speech to text · model `mlx-community/whisper-large-v3-turbo-asr-fp16`
   - Text to speech · model `mlx-community/Soprano-1.1-80M-bf16`
3. Press **Test voice**. You should hear a sentence. Weights download on first
   use, so the first call takes a minute.
4. Open the Chat tab and press the microphone.

Prefer a different transcriber? If you already run **Ollama**, point Speech to
text at `http://localhost:11434/v1` with an audio-capable model such as
`gemma4:latest` — one provider entry can both answer and transcribe.

#### Using it

- **Speak replies** synthesizes each finished sentence as the answer streams, so
  speech starts about a sentence behind the model rather than a whole answer
  behind it. Code blocks are skipped rather than read out symbol by symbol.
- **Hands-free** ends a turn after a stretch of silence and re-opens the
  microphone once the reply finishes. It is **off by default on purpose**: with
  it on, anything audible in the room can become a turn you never addressed to
  the assistant.
- **Stop** ends the turn outright — silences queued speech, discards the
  recording, and cancels the model mid-generation.
- A recording is capped at 60 seconds, and one the app never heard speech in is
  discarded rather than uploaded.

Because a transcript is never proof-read the way a typed message is, the agent's
irreversible tools ask before they run on a spoken turn: deleting a task,
archiving a workspace, starting work on an issue, filing a JIRA issue, syncing
branches, instructing a running agent session, and launching one. Each raises
the same approval prompt external MCP tools use, and is announced aloud when
Speak replies is on. Everything else — reading, recalling, creating tasks — runs
uninterrupted.

#### Choosing models

Model names are free text, because a local server's names are its own. The
accepted shape is `namespace/name` with an optional `:tag`
(`openai/whisper-large-v3`, `whisper:latest`), which is what stops a model name
from addressing something other than the model endpoint.

These are verified working on Apple Silicon through the server above:

| Purpose | Model | Notes |
| --- | --- | --- |
| Speech out | `mlx-community/Soprano-1.1-80M-bf16` | Tiny, no phonemizer. The default worth starting with. |
| Speech out | `mlx-community/Kokoro-82M-bf16` | Nicer voice; set **Voice** to `af_heart`. Needs espeak-ng — see below. |
| Speech out | `mlx-community/MOSS-TTS-Nano-100M` | Clones a voice; see below. |
| Speech in | `mlx-community/whisper-large-v3-turbo-asr-fp16` | Same server as speech out. |
| Speech in | `gemma4:latest` (Ollama) | Audio-capable chat model; transcribes well. |

**Hugging Face** is also available with a token from Settings, but in practice
only for transcription (`openai/whisper-large-v3-turbo`). Its serverless router
refuses the text-to-speech models with "Model not supported by provider
hf-inference", so it is not offered under Text to speech at all.

#### Voice cloning, and server-specific fields

Settings → Voice has a collapsible section for models that need more than a
model name. Two fields:

- **Reference clip** — an audio file, sent as a base64 `ref_audio` data URI.
- **Extra request fields** — arbitrary JSON merged into the synthesis request,
  for whatever else a server wants. Neither can overwrite the model or the text.

Servers disagree about how a reference clip arrives, so which field you use
depends on the server:

- **mlx-audio** wants a *path on disk*. For **MOSS-TTS-Nano**, leave Reference
  clip empty and put the path in Extra request fields:
  ```json
  {"ref_audio": "/Users/you/voice-samples/reference.wav"}
  ```
  (Verified: MOSS-TTS-Nano-100M produces cloned speech this way.)
- **vLLM-Omni** wants the base64 data URI, which is what the Reference clip
  field sends. That is the path to use on an NVIDIA box.

**What the clip has to be.** Nothing is transcribed, so it needs no script and
no particular phrases — MOSS conditions on the audio alone, and passes a
transcript through only to ignore it. Five to ten seconds of ordinary speech is
plenty (upstream's own samples are around eight). Mono WAV.

**Record it at 16, 24 or 48 kHz — not 44.1 kHz.** This one matters more than it
should. The same clip, differing only in sample rate, asked for a two-and-a-half
second sentence:

| Reference rate | Generated |
| --- | --- |
| 44.1 kHz | **76 seconds** of rambling |
| 48 kHz | 4.1s ✓ |
| 24 kHz | 3.8s ✓ |
| 16 kHz | 3.4s ✓ |

44.1 kHz is the CD/consumer default, so a clip from Voice Memos or QuickTime is
likely to be exactly the rate that breaks. It does not error — the request
returns 200 and a minute of nonsense. If your recorder gives 44.1 kHz, resample
before pointing at it:

```bash
say -o ref.wav --data-format=LEI16@16000 "any sentence at all"   # or resample yours
```

#### Running MOSS through vLLM instead (untested)

On Linux/NVIDIA, vLLM-Omni serves MOSS-TTS-Nano over the same OpenAI endpoint:

```bash
vllm serve OpenMOSS-Team/MOSS-TTS-Nano --omni --port 8091
```

Point a provider at `http://localhost:8091/v1` and use the **Reference clip**
field — it requires one on every request and ignores the Voice field entirely.

On Apple Silicon this needs the community
[vllm-metal](https://github.com/vllm-project/vllm-metal) plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash
source ~/.venv-vllm-metal/bin/activate
```

**Untested here, and it may not work at all**: vllm-metal describes itself as a
text-generation backend and documents no audio support or `--omni` flag, so the
TTS serving path likely isn't covered. The mlx-audio route above runs the same
MOSS model natively and is verified, so prefer it on a Mac.

#### If something doesn't work

Press **Test voice** in Settings → Voice first — it plays a fixed phrase and
shows the backend's own error, which distinguishes a wrong model from a missing
key from a cold server. Then:

- **"Model not supported by provider hf-inference"** — Hugging Face does not
  serve that TTS model. Use a local server.
- **"Failed to load image or audio file"** (Ollama) — the audio format. The app
  converts recordings to 16 kHz mono WAV before upload precisely because
  backends disagree here, so this points at a hand-made request rather than the
  app.
- **"ffmpeg not found"** — only mp3 needs it. Yarvis asks for `wav`, so this
  only appears if you override `response_format` yourself.
- **"the speech provider returned no audio"** — the server answered OK with an
  empty body, which means it failed after it started responding. Its own log has
  the real reason.
- **A cloned voice rambles for a minute** — the reference clip is probably
  44.1 kHz. See "What the clip has to be" above; resample it to 16 kHz.
- **Kokoro fails with `espeakng_loader//phontab: No such file or directory`** —
  its grapheme-to-phoneme step looks for espeak-ng data one directory above
  where mlx-audio ships it. Installing espeak-ng system-wide does *not* help,
  because the path is hard-coded. Either use Soprano, which needs no phonemizer,
  or link the data where it looks:
  ```bash
  cd .venv/lib/python3.12/site-packages/espeakng_loader && ln -sf espeak-ng-data/* .
  ```
- **No microphone prompt** — macOS gates it. The app bundle carries the usage
  description and audio-input entitlement, but under `bun run tauri dev` the
  binary is not bundled, so the prompt is attributed to the terminal that
  launched it. Run a built app if permission looks stuck.

Speech settings live in Postgres rather than this window, so every surface
shares one setup — including the Telegram bot once it grows voice notes
([#226](https://github.com/bennettaur/yarvis/issues/226)). Starting the speech
server is still a manual step; having the app supervise it is
[#228](https://github.com/bennettaur/yarvis/issues/228).

### Embeddings

The `memories.embedding` column is `vector(1536)`, and the active embedder's
output dimension must match it (the model's output is truncated to it). Configure
an embeddings provider under **Settings → Embeddings**: an OpenAI-compatible
endpoint — a LiteLLM gateway fronting Gemini, or a Qwen3 embedding server (base
URL e.g. `http://localhost:4000/v1`, model e.g. `gemini-embedding-001`). Without
one, Yarvis uses Gemini directly when keyed, otherwise an offline hash embedder.
Each memory records the embedder identity (kind/model/dim) so a provider or
dimension change is detected and surfaced as a "re-embed needed" warning.

Note: the embeddings migration sets the column to `vector(1536)` and **clears
existing embeddings** (memory *content* is preserved). After upgrading, configure
a provider and run **Re-embed all** in Settings (or `POST /api/memory/reembed`)
to regenerate vectors.

All secrets live in a **single** Keychain item (one JSON object), rather than
one item per secret. macOS authorizes Keychain access per item, so consolidating
means a session is authorized once instead of prompting for every secret in
turn.

> **Upgrading from an earlier build:** secrets previously lived in one item per
> key, so re-save each secret once in Settings to populate the consolidated
> item. The old per-key items are no longer read and can be deleted from
> Keychain Access if you want to tidy up.

> **Touch ID:** gating this item behind Touch ID requires the app to be
> code-signed with an application-identifier entitlement so it can use the macOS
> data-protection keychain — unsigned dev builds fall back to the login-password
> prompt. That signing work is tracked separately; once it lands, the single
> authorization becomes a single Touch ID tap with no further change here.

For Google Calendar, create a **Desktop app** OAuth client in Google Cloud
Console and register the loopback redirect
`http://127.0.0.1:<sidecar-port>/oauth/google/callback` (any port is accepted
for Desktop clients), then enter the client id/secret in Settings and connect
from the Calendar tab. See `ROADMAP.md` for the full verification steps.

### Connected MCP servers

**Settings → Tools & MCP → MCP servers** is where you add the servers Yarvis
connects *out* to (as opposed to the endpoint it serves — see "Yarvis as an MCP
server"). A server is either **remote** (Streamable HTTP / SSE, given a URL) or
**local** (a stdio subprocess, given a command and arguments). Its structure is
stored in Postgres; its credentials go to the Keychain. Press **Connect** to
attach and pull the server's tools into the tool registry, then decide per tool
in the Tool Manager whether it is always mounted, discoverable by search, or off.

A remote server authenticates one of two ways:

- **Auth headers** — name the headers on the server (e.g. `Authorization`), save,
  then fill in each value. Values are Keychain-backed and take effect after the
  sidecar restarts, which Yarvis does for you.
- **Sign in with OAuth** — tick the box on a remote server instead. Yarvis then
  runs the MCP authorization flow: it discovers the server's authorization
  server, registers itself as a public client (dynamic client registration,
  PKCE), and **Authorize** opens your browser to consent. The tokens land back
  on a loopback redirect, get stored in the Keychain, and refresh on their own
  while the app runs.

  Leave **Scopes** blank and Yarvis reads them from the server's
  protected-resource metadata (`scopes_supported`) and requests those. Blank does
  *not* mean "no scopes": a token issued for none is still a valid token, and a
  server that needs one refuses each request instead of the authorization, which
  surfaces as a confusing protocol error rather than "you lack a scope". Set the
  field explicitly to request fewer than the server advertises — worth doing if
  it lists identity scopes (`openid`, `profile`, `email`) the tools don't need.
  Include `offline_access` if the server wants it before issuing a refresh token.

  Changing the scopes re-registers the client, so you authorize once more.

  The redirect Yarvis registers is
  `http://127.0.0.1:<sidecar-port>/oauth/mcp/callback`. That port is picked fresh
  each time the app launches, so the registration is remade — and you authorize
  once more — after a restart. Nothing to configure; it just means the first
  Connect of a session may ask you to sign in again.

  **Sign out** forgets both the tokens and the registration.

The two compose: an OAuth server can still carry extra headers (a tenant id, say)
alongside its bearer token. `Authorization` itself is reserved and can't be set
as a custom header on either kind.

When a connection fails, the card shows the reason and the sidecar log carries
the full version — status, URL, and response body. If a server's replies don't
match the MCP schema and the complaint alone doesn't explain why, launch with
`YARVIS_DEBUG_MCP=1` to log what it actually sent:

```bash
YARVIS_DEBUG_MCP=1 bun run tauri dev
```

### Workspaces

Workspaces manage their own repo clones and git worktrees under a base
directory, `~/dev/yarvis-workspaces` by default and overridable with the
`YARVIS_WORKSPACES_ROOT` env var (non-secret config, unlike the Keychain
secrets above). Add repos and edit their per-repo setup/run scripts in the
Settings tab's Repositories section.

Each row in the workspace list carries a badge per repo that has a pull
request, beside the workspace status, so a list of "active" workspaces still
says which one wants you: `◇` open and awaiting review, `◌` draft, `●` checks
running, `✗` checks failing, `⚠` merge conflicts, `✎` changes requested, `✓`
approved, `◆` merged, `⊘` closed. Hovering names the repo, the PR number and
the state. The badge shows whatever needs acting on first, so a red build on an
approved PR still reads as failing, and `✓` means someone with write access
signed off — the repo's own rules (required reviewers, CODEOWNERS) can still
hold the merge. Azure DevOps PRs report no check state here, so theirs reflects
the review only. The badges come from the same background PR poll the workspace
page uses, so they lag a change by up to a minute.

Every provisioned workspace opens with an agent tab and nothing else — opening
one starts a Claude Code session in it (or attaches to the one already running)
and focuses that tab. No extra shell tab is opened alongside it; use `+` or
Cmd+T when you want one. Closing the agent tab kills its session, and nothing
reopens it while you stay on that workspace — but the dismissal is per-visit, so
switching workspaces (or leaving the Workspaces tab) and coming back counts as
opening the workspace again and starts a fresh session. The header's start-session
button brings one back on the spot.

An issue's "Start work" is held by the sidecar on the workspace itself, not by
the screen you started it from, so navigating away mid-kick-off doesn't strand
it. Reopening the workspace rejoins the provisioning run already in flight and
picks its log back up, then launches the agent on the ticket once it lands. If
provisioning failed, the ticket is still waiting behind "Retry provisioning".

The agent's tab title and launch command are set under Settings → Repositories →
Agent, defaulting to `Claude` and `claude --permission-mode auto`, so you can
bake in default options such as a model or permission mode. The
`YARVIS_CLAUDE_COMMAND` env var still overrides the stored command (non-secret
config) for the cases where it has to be injected without the settings file.

Remote Control is opt-in per launch. A session started from Telegram gets
`--remote-control <session name>` appended, since you're away from the machine
and can only reach it from claude.ai/code or the Claude mobile app. Sessions
started at the laptop — opening a workspace, an issue's "Start work", or asking
the in-app agent — don't, because they open in a tab you're already looking at;
enable Remote Control from inside the session if you later need to pick the work
up remotely. Keeping it off by default also means a non-Claude agent command
isn't handed a flag it doesn't understand.

Provisioning also writes a few context files into the workspace root, since
Claude starts there rather than inside a single repo: `AGENTS.md` (plus a
`CLAUDE.md` that includes it) describing which repos are present and on what
branch, and a `.claude/settings.json` that registers each repo's
`.claude/skills` and `.claude/agents` so those skills and agents still load
even though Claude runs one directory above the repos. It also writes a
`.mcp.json` pointing the session at Yarvis's own MCP endpoint (see "Yarvis as an
MCP server"). Both files are merged, not overwritten, so any other keys — or
other MCP servers — already present are left intact. A
workspace opened from an issue's "Start work" also gets the ticket itself, in
`.yarvis/issue-prompt.md` — the file its agent session is launched to read, as
the last step of provisioning.

When several workspaces need the same upstream fix, ask the in-app agent (or
Telegram) to merge main into them — "merge main into all my open PRs" — and it
syncs them in bulk: fetch, merge each branch's base into it, and push the branch
when the remote is missing commits. A repo is left alone, and the reason
reported, when its worktree has uncommitted changes, is part-way through a
merge/rebase/cherry-pick/revert, isn't on the workspace's own branch, or isn't
finished provisioning. Note that a branch you have never pushed is published by
this, since it counts as ahead of a remote it doesn't have yet.

A merge that conflicts is left in the worktree with its markers in place and
isn't pushed, so you can pick it up yourself or hand it back: the agent can type
an instruction like "resolve the merge conflicts and commit" straight into that
workspace's running session, and it's answered there in the background. That send
is refused unless the configured agent itself is what's reading the session's
prompt — if it has exited, or you left something else running in that terminal,
nothing is typed — and an instruction may not open with `!`, `/`, `#`, or `@`,
which the agent reads as a command rather than a request. What it can't tell is
*what* the agent is showing: submitting while a permission prompt is up answers
that prompt, so it confirms delivery only, never that the work was done.

At most 60 terminal sessions can be live at once; opening more fails until one
is closed. Raise or lower that under Settings → Repositories → Terminals (up to
1000) — each session is a real shell, so the cap trades memory and process count
for how many workspaces you can keep open. Leaving the field blank restores the
default. The value applies to the next terminal opened, without a restart, and
is stored in `settings.json` in the app data directory.

#### Reviewing your own work

The right column's **Changed** list opens a file's diff in a tab, and that diff
takes comments the way a PR review does. Drag down the line-number gutter to
pick out a range — or use the **+** that appears on hovering a line for a single
one — and the note hangs under the last line it covers. Comments attach to the
right-hand (new file) line, the side a PR review anchors to, so a line the
change only deletes takes no comment. Each one records the file, the lines, and
the commit the worktree was on when you wrote it, shown abbreviated on the card
so you can tell a note written against older code from one written against what
is there now.

Nothing is published: the comments live in the local database and never reach a
PR, which is the point — reviewing your own change on github.com means leaving
feedback other people read, and that goes obsolete as soon as the agent acts on
it. The **Comments** tab beside Changed lists the whole review, spanning every
repo in the workspace and carrying a count of what is still open; a comment's
file-and-line heading opens that diff. **Copy for Claude** puts the review on
the clipboard as numbered entries to paste into the agent session.

**Resolve** on a comment marks it dealt with — it stays in the list, so a
decision isn't lost, but drops out of the copied text; **Reopen** puts it back
and **×** deletes it outright. Archiving a workspace deletes every comment in
it once the worktrees are actually gone: they were scaffolding for work that is
done. An archive that stops partway (a worktree that won't remove) is still
reopenable, so its comments are left where they are.

### Clipboard

#### Copy buttons

Referencing something from Yarvis elsewhere — Slack, a ticket, an agent prompt —
shouldn't mean opening a browser to fetch the link first, so the things worth
quoting carry a copy button next to them. In a workspace: the workspace folder,
each repo's worktree path, the PR link on the status line and in the PR checks
view, that view's check summary, and both file lists — each row's full path, or
the whole list one path per line. In a PR review: the provider's link to the PR,
to each file (pinned to the commit the PR points at, so it still shows the code
you meant after a later push), and to each check, plus every check at once as one
line each. On an issue: its GitHub or JIRA link.

Anything a provider supplies is sanitized on the way out. Control and formatting
characters are stripped per field before lines are joined, so a filename or a
check name carrying a newline can't forge a line of its own in what you paste. A
link is copied only if it is one Yarvis would open — the same http(s) rule the
"Open ↗" buttons use — and a file link whose path carries `.` or `..` segments,
which git will not store, is refused rather than copied: a browser resolves those
away, landing the reader somewhere other than the repo the link appears to name.
Where a link can't be derived at all, no button appears.

**Control + Shift + V** (or the clipboard icon in the nav rail) opens the
clipboard palette: a search box over the things you copy again and again — an
identity id, a CLI incantation, a link — plus the clipboard history from this run
of the app. Arrows move the selection, Enter copies the highlighted row and
closes the palette, Esc dismisses it. Entries can be labelled, tagged, and
pinned; pinned entries sort first, then whatever you have copied most recently,
so an empty search already offers what you usually want.

A clip out of history can be promoted to a permanent entry with **Save**, and
**Clear history** forgets everything recorded so far. History is never written to
disk: it lives in memory in the Rust core, capped at the last 100 clips, and goes
away when the app quits.

**This is not a secret store.** Saving an entry is refused when the text looks
like a credential — provider token prefixes (GitHub, AWS, Slack, Google, Stripe,
npm, `sk-…` API keys), PEM private-key blocks, JWTs, URLs with an embedded
password, inline `password=`/`api_key=` assignments, and long high-entropy tokens
— and clipboard history is screened with the same patterns, so a password that
passed through your clipboard is withheld from the palette rather than listed
(the footer says how many were hidden). Detection is a heuristic, so it errs
toward loud: identifiers the feature exists to hold (UUIDs, hex digests, plain
URLs, commands whose secret is a `$VAR` reference) are deliberately left alone,
but a base64 blob may well be refused. Secrets belong in the Keychain, entered
under Settings.

### PR review

The PRs tab lists **My PRs**, **Needs review**, **Reviewing**, and saved
**Filters**, grouped under collapsible per-repo headers (a collapsed repo stays
collapsed across tabs and restarts). Leaving the PRs tab and coming back drops
you where you were — same provider, same list, and the same PR if you were
reading one; that too survives a restart. The box above the tabs jumps straight to a
PR you can already name — paste a `https://github.com/owner/repo/pull/123` link,
or type `owner/repo#123`; a bare `repo#123` resolves against your registered
repos, and if the name matches several owners you're asked which one.

Two things are configurable under **Settings → PR review**:

- **"Needs review" search** — the GitHub issue search behind that tab, run
  as-is, so you decide what counts as needing your attention (drop drafts,
  narrow to an org, exclude PRs you've already reviewed). Defaults to
  `is:open is:pr review-requested:@me`; a few presets are one click away.
- **"Reviewing" history** — how far back that tab looks, in days (30 by
  default).

**Reviewing** shows PRs you've actually engaged with, from two signals: PRs
opened in yarvis (recorded as `pr.viewed` in the local event log) and GitHub's
record of your comments and submitted reviews. It splits into **In progress**
and **Complete** — merged, closed, or approved by you — with the latter
collapsed. An approval superseded by a later change request counts as in
progress again. GitHub only: Azure DevOps exposes neither half of that signal.

#### Working on the PR

The header carries one workspace control. For a PR you raised from a workspace
it jumps back to it; for anyone else's, **Start workspace** creates one checked
out on the PR's own branch, and opens it. That workspace starts nothing — no
ticket, no prompt — so what comes up is an agent session at a blank prompt, to
ask about the change or push a fix from. Provisioning (clone, worktree, setup
script) runs in the sidecar, so it finishes whether or not you stay on the
screen; the workspace shows its log while it does.

The PR's repo has to be registered under **Settings → Repositories**, since that
is where the clone comes from, and the branch has to live in it — a PR from a
fork is refused rather than provisioned into a git error. Clicking twice is
safe: the second click finds the workspace the first one made. The button
becomes the backlink once the PR poll notices the workspace, up to a minute
later.

#### Reading a diff

Files open as you scroll toward them, and **Collapse all** / **Expand all**
folds the set when you want the file list at a glance. **Unified** / **Split**
switches between one column and the old file beside the new one; the choice
sticks across PRs. Each `⋯ N lines` marker between hunks reveals the code the
patch left out — twenty lines from either end, or the whole stretch by clicking
the count — and a per-file **Whole file** shows the complete file with its
changes still highlighted, plus a strip down the edge marking where in the file
they fall. A file's full text is only fetched once you ask for context. Two
copy buttons sit beside each filename — the repo-relative path, for an editor or
a prompt, and the provider's link to that file at the commit the PR points at,
for anyone you're pasting to (see "Copy buttons"). Both are always shown in the
diff header, and appear in the file list on hovering a row, where only the
basename is visible. Clicking a row scrolls its diff into view and flashes the
file's header, so a jump lands somewhere you can see it arrived.

#### Guided review and line insights

**Guided review** (beside the Files heading) has an agent read the change and
lay out an order to review it in, working from the outside in — the request
that arrives, then what handles it, down to what it finally writes. Each step
names a file and lines with a sentence on why it comes there, and the box docks
to the bottom of the review with back/next. A location too long for the box
keeps its file name and line numbers and drops directories from the front of the
path, with the whole thing on hover; clicking one jumps to the code and flashes
that file's header. A guide is generated once per PR and
kept until you approve, request changes, or merge; pushing new commits marks it
out of date rather than deleting it, and anything untouched for 30 days is swept.

Not every file gets a stop of its own. Data files, schemas, models and fixtures
fold into one **data sanity check** step — the agent reports that it checked the
models are pragmatic, the names semantic, and the human-facing descriptions
accurate — and test files fold into a **test sanity check**, read against the
code they cover for untested paths, tests that only exercise their own mocks,
and departures from how the repo's other tests are written. A file that mixes
data with logic still gets a walkthrough step for its logic. Steps also carry
what the agent thinks is *wrong* — an unhandled failure path, a comment that no
longer describes its code, a misleading name — each a click away from the line
it is about.

**Next** marks every file the step accounted for as viewed — the same per-file
state the Viewed pill sets, synced to github.com — so a sanity check clears all
the files it covered in one move. The last step offers **Finish** instead, which
credits its files and ends the tour. **Back** is re-reading, and unmarks nothing;
jumping to a step marks nothing either. A step only ever covers files this pull
request changed, and never one another step walks you through.

The **?** beside any line asks about that code — shift-click to extend from the
last line you asked about. Answers are stored against those lines and shown
inline. They are your own notes, not review feedback: nothing reaches the author
until you press **Post**, which turns one into a real line comment. Unlike
guides they are kept indefinitely, and the assistant can search them ("what did
I work out about that file?", "where did I leave off?").

Both are agent runs against your configured LLM provider, so they need a
provider key in Settings on top of the GitHub/Azure token, and neither is cheap:
a tour gives the agent up to 60 tool-calling steps to explore the change and a
line question up to 16, each carrying diffs and file contents.

### Telegram remote control

Chat with Yarvis — and issue control commands — from Telegram. The sidecar runs
a bot that drives the same chat agent as the in-app UI; it requires a configured
database and at least one LLM provider.

Setup:

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its HTTP API
   token (format `123456:ABC-DEF...`).
2. Enter it under **Settings → Telegram** (stored in the Keychain; saving
   reloads the sidecar to pick it up).
3. Message your bot `/whoami` — it replies with your chat id. Until at least one
   id is on the allowlist the bot answers **only** `/whoami`; once the allowlist
   is set it ignores any chat that isn't on it.
4. Paste your chat id (comma-separated for several) into **Allowed chat ids** and
   save.

Access is restricted to **private** chats on the allowlist — the bot ignores
groups, channels, and bot senders. Commands:

- `/new_chat` — start a fresh chat session
- `/chats` — list recent sessions; `/switch <n>` — switch the active one
- `/model` — show the current provider/model and the available options
- `/setmodel <provider> <model>` — reply using a specific provider/model
- `/whoami` — show your chat id; `/help` — list commands

#### Optional second factor (OTP)

For defense against Telegram-account takeover (a stolen session or SIM swap, where
the attacker *is* your allowlisted chat), enable a TOTP second factor under
**Settings → Telegram → Two-factor unlock**. Yarvis generates a secret you add to
an authenticator app (Authy, Google Authenticator, 1Password, …); after that the
bot won't act until you send `/unlock <code>` to open a window (default 2h,
configurable). `/lock` ends the window early. The window relocks on restart, codes
are rate-limited with a lockout after repeated failures, your `/unlock` message is
deleted so the code doesn't linger, and the app raises a desktop notification on
each unlock/failed/lockout so you see access you didn't initiate. The code is
verified in the sidecar; it never leaves your authenticator and laptop.

## Development

```bash
# Run the full app (frontend + Rust core, which spawns the sidecar)
bun run tauri dev

# Run the sidecar standalone (prints a dev bearer token)
bun run sidecar:dev
```

### Running more than one instance

A branch under development can run beside the app you use day to day. Give the
second one a name:

```bash
bun run dev:instance migration-test
```

The name selects a bundle identifier (`com.mikebennett.yarvis.migration-test`)
and a pair of Vite dev-server ports derived from the name — the same pair on
every relaunch, moving to the next free pair in the 1430–1489 range if something
else holds one. (The second port of each pair is the HMR socket, which Vite uses
when `TAURI_DEV_HOST` is set.) `YARVIS_DEV_PORT` pins an explicit port instead;
an occupied one then fails the launch rather than moving. Because macOS derives
the app data directory from the identifier, each instance gets its own
`settings.json`, `alarms.json` and core control socket, and the single-instance
guard no longer sends the second launch to the first window. The window title
carries the name so they're distinguishable on screen.

All of that separation is the launcher's doing, not the environment variable's.
Setting `YARVIS_INSTANCE` on a plain `bun run tauri dev` makes the process stand
down from the hotkeys and background workers below, but leaves the bundle
identifier alone — so it shares the primary's `settings.json`, `alarms.json` and
control socket, and the single-instance guard still redirects the launch. Use
`dev:instance`.

Both instances read the **same Keychain item**, so provider keys, tokens and the
database URL are entered once and shared. That means the second instance is
looking at your real data by default — which is what you want for most testing.
To isolate it (a migration under development is the usual reason), point it at
its own database:

```bash
createdb yarvis_dev
psql -d yarvis_dev -c "CREATE EXTENSION IF NOT EXISTS vector;"

YARVIS_DATABASE_URL="postgres://localhost:5432/yarvis_dev" \
  bun run dev:instance migration-test
```

`YARVIS_DATABASE_URL` overrides only the Keychain's database URL; every other
secret still comes from the shared item. Migrations run against whichever
database the instance is pointed at, so a schema change under test never reaches
the primary one. Two cautions:

- The Settings screen reads and writes the **shared** Keychain `database_url`,
  not the override the instance is actually running against. Changing it from an
  isolated instance's window repoints the primary.
- A connection string on the command line lands in your shell history and in
  `ps` output. Export it or use a `.pgpass` if it carries a password.

Some work belongs to exactly one process, and a named instance leaves it to the
primary one by default:

| What | Why it's singular | Override |
| --- | --- | --- |
| Telegram bot | Telegram rejects a second long-poll consumer of the same token | `YARVIS_BACKGROUND_WORKERS=1` |
| Workspace/PR poller | Doubles provider API traffic and writes the same rows twice | `YARVIS_BACKGROUND_WORKERS=1` |
| Resuming interrupted kick-offs | Would launch two agent sessions in one workspace | `YARVIS_BACKGROUND_WORKERS=1` |
| Stale PR-guide sweep | Deletes rows on a schedule; once is enough | `YARVIS_BACKGROUND_WORKERS=1` |
| Global hotkeys (`Control + Shift + Space`, `Control + Shift + V`) | One process holds an accelerator machine-wide | `YARVIS_GLOBAL_SHORTCUTS=1` |

Set an override to `1` on the instance that should take the work, or `0` on the
primary to make it stand down instead; only `1`/`true` and `0`/`false` are read,
and anything else is ignored.

A separate database does **not** make the whole set safe to run twice — it only
covers the rows. The Telegram bot token comes from the shared Keychain either
way, so a second bot splits your real command stream between two processes, one
of which is running unreviewed code; and the workspace poller still doubles
provider API traffic against your rate limit. Turning the workers on in a second
instance is reasonable for the kick-off resume and the guide sweep once it has
its own database, but give it its own bot token before you let it near Telegram.

Workspaces are still shared: both instances create worktrees under
`YARVIS_WORKSPACES_ROOT` (default `~/dev/yarvis-workspaces`). Point an instance
elsewhere with that variable if you want its worktrees kept apart too.

## Testing

```bash
bun run test                   # frontend (src/) + dev-script (scripts/) tests
bun test sidecar/              # sidecar unit/integration tests
bun run --cwd sidecar typecheck
bun run build                  # typecheck + build the frontend
```

Frontend tests use `bun test` with a happy-dom environment; the dev-script
tests under `scripts/` are plain Bun and need none of it. The preload in
`src/test/setup.ts` registers the DOM, pins the timezone, and stubs the Tauri
runtime APIs; component tests stub the sidecar data layer (`src/lib/api`) and
render real components with the `renderToHtml` helper in `src/test/render.tsx`.

## Project layout

```
src/            React frontend (Vite + TS + Tailwind)
  lib/          sidecar API client, Keychain wrappers, Omni Chat context registry, notifications, cross-tab nav (nav.ts),
                voice loop pieces (useVoice.ts the turn hook, voice.ts + voiceConfig.ts clients,
                useVoiceRecorder.ts mic capture, speechChunks.ts sentence splitting,
                speechQueue.ts pipelined playback, audioEncoding.ts, audioPlayback.ts)
    pr/         provider-agnostic PR data layer (GitHub + Azure DevOps transports, cache, refs, per-file viewed state, remembered panel place, link/shorthand locator, diff parsing + context expansion, guide + insight clients)
    issues/     provider-neutral issue data layer (GitHub + JIRA) — types, api client, start-work flow (useGithubStartWork.ts)
    jira/       JIRA-specific data layer (issue detail, transitions, comments, create) — types, api client, start-work flow (useJiraStartWork.ts)
    find/       find-on-page engine — visible-text index, match offsets, CSS Custom Highlight painting, useFind controller
  components/   one panel per tab (Chat, Tasks, PRs, Memory, Calendar, Terminal, Workspaces, …)
    voice/      the mic button and the voice controls shared by the chat surfaces
    pr/         PR dashboard + embedded review: lists, file diffs (unified + split),
                gap/context expansion, change minimap, guide panel, insight cards
    issue/      Issues tab views: GitHub + JIRA issue lists, detail, create/repo-picker modals
    files/      shared file-tree rows (collapsible folders), used by PR review and workspaces
    workspaces/  workspace detail subviews + Omni widgets, and the self-review
                comment layer over a changed file's diff
    shell/      desktop shell: nav rail, top bar, boot loading screen, tab shortcuts
    omni/       Omni view — chat-driven dynamic-UI canvas
    omnichat/   Omni Chat — global summon-from-anywhere chat overlay
    clipboard/  clipboard palette — saved snippets + screened clipboard history
    find/       find-on-page bar (Cmd+F), hosted by the shell over the content region
  omni/         json-render component catalog, registry, layout primitives
src-tauri/      Rust core (Tauri v2)
  src/keychain.rs   Keychain-backed secret commands (single consolidated item)
  src/instance.rs   which instance this process is, and what it therefore owns
  src/sidecar.rs    sidecar supervisor
  src/pty.rs        PTY sessions (terminals + workspace agent sessions), owned by the core
  src/control.rs    fixed-method UDS control channel the sidecar drives PTY sessions through
  src/alarms.rs     full-screen alarm scheduler
  src/clipboard.rs  clipboard read/write + in-memory (never persisted) clip history
sidecar/        Bun + TS service (Hono)
  src/core/     client for the Rust core's control channel (spawn/kill/send to a session)
  src/db/       Drizzle schema, client, migrations (applied on startup)
  src/chat/     multi-provider streaming chat + tool-calls (agent.ts: shared agent turn)
  src/voice/    speech-to-text + text-to-speech (/api/voice): Hugging Face Inference
                and the OpenAI audio API, the latter reusing a custom provider's base URL;
                config.ts holds the settings every surface shares
  src/clipboard/ saved clipboard entries + the credential screen (screening.ts)
  src/telegram/ Telegram remote-control bot (long-poll loop, slash commands, chat→session map)
  src/tasks/    daily/weekly work tracking
  src/events/   local on-device event log (action trail; reconciled to memory later)
  src/memory/   pgvector memory, notes, ingestion, recaps
  src/github/   GitHub PR dashboard + embedded review (REST + GraphQL), dashboard config, in-progress review roll-up
  src/azure/    Azure DevOps PR dashboard + embedded review (REST; diffs built with jsdiff)
  src/pr/       provider-neutral PR review subsystem (/api/pr): guide + insight storage,
                the tour/ask agent runs, provider-agnostic code tools (read file, list dir,
                search) over a GitHub/Azure source seam, opening a workspace on a PR's
                branch (workspace.ts), and the chat agent's review tools
  src/issues/   provider-neutral issue routes/service (stars, filters, workspace links, start-work, issue writes)
  src/jira/     JIRA Cloud REST client + routes + agent tools + ADF↔Markdown conversion
  src/google/   Google Calendar OAuth + events
  src/omni/     Omni UI generation (streaming) + saved layouts
  src/workspaces/ repo registry + git-worktree provisioning, bulk base-branch sync, and
                  teardown (/api/repos, /api/workspaces), plus local self-review
                  comments on a workspace's own diffs (reviewComments.ts)
  src/mcp/      MCP client: connected servers, OAuth, tool registry sync, approvals
  src/mcpServer/  the MCP endpoint Yarvis serves (memory tools over /mcp)
  src/attention/  attention stream: hook ingest, SSE stream, scoped clearing
  src/chat/attentionTools.ts  request_attention tool (badge + OS notification)
  drizzle/      generated SQL migrations
scripts/        dev tooling (dev-instance.ts: launch a named second instance)
```

## Yarvis as an MCP server

Yarvis serves its own MCP endpoint, so Claude Code (or any other MCP client) can
reach into the app. Today it exposes the memory tools — `recall`, `remember`,
`take_note`, `list_memories`, `forget` — over the same pgvector store the in-app
chat uses, so a coding session can look up what you told Yarvis last week and
write back what it learns.

The endpoint is `POST http://127.0.0.1:<sidecar port>/mcp`, authenticated with a
scoped token that grants access to those tools and nothing else — not the rest of
the API, which keeps its own bearer. It also checks the `Host` header, so a page
that resolves a name it controls to 127.0.0.1 can't reach it. Both the port and
the token are allocated once per app launch: restarting the sidecar (which saving
a secret does) keeps them, relaunching Yarvis picks new ones.

**Sessions Yarvis launches need no setup.** Workspace provisioning writes a
`.mcp.json` at the workspace root pointing at `${YARVIS_SIDECAR_PORT}` with an
`Authorization: Bearer ${YARVIS_MCP_TOKEN}` header, and the core injects both
variables into the session's shell — so the file on disk carries no secret. Claude
Code asks you to approve the project's MCP server the first time it sees it. Two
caveats: a workspace provisioned before this existed gets the file when it is next
provisioned, and only sessions the UI can navigate to (a workspace's agent
session, a workspace or standalone terminal pane) receive the variables — the same
sessions that can raise an attention item.

**Any other client** — Claude Code in a terminal Yarvis didn't spawn, another
editor — needs pointing by hand. *Settings → Tools & MCP → Yarvis MCP endpoint*
shows the URL and token and copies a ready-made `claude mcp add` command. Re-copy
it after relaunching Yarvis, since the token is new. Against a standalone sidecar
(`bun run sidecar:dev`) the token is generated and never printed, so set
`YARVIS_MCP_TOKEN` yourself if you want to point a client at one.

Memory contents are treated as untrusted reference data on the way out: `recall`
and `list_memories` fence each hit in tags carrying a per-request nonce and name
that nonce in the accompanying warning, so content that writes a closing tag of
its own can't end the block and address the calling agent. Memories written
through this endpoint are stamped `source: "mcp"` and reported as such, so a
reading agent can tell what it wrote itself from what you said.

## Attention stream

The bell in the top bar collects everything waiting on you — chiefly a Claude
Code session blocked on a permission prompt or idle waiting for input, raised by
the hooks Yarvis writes into each workspace's `.claude/settings.json`.

Items are keyed by the PTY session that raised them. A terminal the app can
navigate back to — a workspace's tabs and the standalone Terminal tab — carries
`YARVIS_SESSION_KEY` (plus `YARVIS_WORKSPACE_ID` when it belongs to a workspace)
and a create-only ingest token, so a Claude run started by hand in one of a
workspace's terminal tabs flags *that* tab rather than the workspace as a whole.
The same env carries the scoped MCP token (see "Yarvis as an MCP server"), which
is why the two features reach the same set of sessions.

How the stream behaves:

- **Grouped by origin.** Repeat asks from one workspace collapse into a single
  row with a count, naming the tabs involved; dismissing it clears them all.
- **Cleared by looking.** Opening the workspace — or the terminal tab — that
  raised an item marks it read, and an item raised by something already on screen
  never fires an OS notification. Nothing auto-clears while the window is in the
  background.
- **Highlighted where it happened.** A workspace with something pending is marked
  in the workspace list, and the tab behind it is marked in the terminal tab strip,
  so a flag is findable while you're looking elsewhere.

## Keyboard shortcuts

- **Cmd/Ctrl + 1–9** — jump to the Nth tab in the nav rail.
- **Cmd/Ctrl + Shift + ] / [** — cycle to the next / previous tab (wraps around).
- **Control + Shift + Space** — summon **Omni Chat** from anywhere: a centered chat
  overlay that receives a snapshot of the screen you're on (e.g. the PR you're
  reviewing) as context. Esc hides it while the conversation keeps streaming in the
  background; re-summoning resumes the same session. The agent can call
  `request_attention` to raise a nav-rail badge and an OS notification when it needs
  you. Any view contributes context by calling the `useOmniChatContext` hook.
- **Control + Shift + V** — summon the **clipboard palette** from anywhere: search
  your saved snippets and this run's clipboard history, Enter to copy, Esc to
  close. See "Clipboard" above for what it refuses to store.
- **Cmd/Ctrl + F** — **find on page**: a search bar over the current view's text.
  Every hit is tinted and the current one picked out; Enter / Shift+Enter (or
  **Cmd/Ctrl + G** / **Cmd/Ctrl + Shift + G** from anywhere) step between them,
  `Aa` toggles case sensitivity, Esc closes. The search follows the view as it
  changes — a streaming chat reply or fresh terminal output is re-matched — and
  only covers what is actually rendered, so collapsed diff files and terminal
  scrollback that has scrolled out of the viewport are not searched.
