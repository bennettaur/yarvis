# Configuration

Yarvis keeps its configuration in three places, split by what the value is:

| Kind | Where | Set from |
| --- | --- | --- |
| Secrets: API keys, tokens | One item in the macOS Keychain, or in 1Password | **Settings → Credentials** |
| Everything else you change from the UI | `~/.yarvis/settings.json` | The Settings screen, or by hand |
| Machine-level overrides | Environment variables | Your shell, before `bun run tauri dev` |

Your data (chat history, memory, tasks, workspaces, PR notes) isn't
configuration. It lives in Postgres.

## The database URL

The server needs Postgres before anyone can sign in, so its URL is set where
the server starts, not in Settings. It comes from `YARVIS_DATABASE_URL`, then
`url` under `[database]` in the server's `server.toml`, then (on an install
from before this) the `database_url` the Keychain or 1Password item still
holds, and otherwise `postgres://localhost:5432/yarvis`. The server passes it
to the sidecar as `DATABASE_URL`. **Settings → Credentials** shows it with any
password masked, and where it came from. See "Postgres" in
`docs/client-server.md`.

Secrets never go in env files or in the repo.

## Secrets

Every secret sits in **one** Keychain item (service `com.mikebennett.yarvis`,
account `secrets`), stored as a single JSON object. macOS asks for permission
per item, so one item means one prompt per session instead of one per secret.

The Rust core reads that item when it starts the sidecar and passes each value
in as an environment variable. The UI can save and clear a secret, but it never
reads one back.

| Setting | Used for | Passed to the sidecar as |
| --- | --- | --- |
| Anthropic API key | Claude chat | `ANTHROPIC_API_KEY` |
| Gemini API key | Gemini chat, embeddings, cloud voice | `GEMINI_API_KEY` |
| Cerebras API key | Cerebras chat | `CEREBRAS_API_KEY` |
| Hugging Face token | Cloud speech to text | `HUGGINGFACE_API_KEY` |
| GitHub token | PRs, issues, stacks, review sync | `GITHUB_TOKEN` |
| Azure DevOps token | Azure PRs, Azure Boards | `AZURE_DEVOPS_TOKEN` |
| JIRA API token | JIRA issues | `JIRA_API_TOKEN` |
| Google client secret | Google Calendar | `GOOGLE_CLIENT_SECRET` |
| Merge reviewer signing key | Signing the merge reviewer's PR approvals | `VERIFY_AGENT_SIGNING_KEY` |
| Telegram bot token | The Telegram bot | `TELEGRAM_BOT_TOKEN` |
| Telegram allowed chat ids | Who the bot answers | `TELEGRAM_ALLOWED_CHAT_IDS` |
| Telegram OTP secret | The bot's optional second factor | `TELEGRAM_OTP_SECRET` |

The same item also holds the credentials for custom LLM providers, MCP servers
and the embeddings provider.

The Telegram chat-id allowlist isn't a credential, but it stays in the Keychain.
With the OTP second factor off, it is the bot's only access check, so it
shouldn't be a plain, freely editable setting.

Cerebras takes only a key. Its endpoint is fixed, and Yarvis talks to it
through its OpenAI-compatible `/chat/completions` API, so there is no base URL
to set.

AWS Bedrock uses the standard AWS credential chain (`~/.aws`, `AWS_PROFILE`,
`AWS_REGION`, default region `us-east-1`), not a Keychain entry.

### Token scopes

- **GitHub.** The simplest option is **Sign in with GitHub** above the GitHub
  token field. Yarvis shows a short code and
  opens github.com/login/device. Enter the code and approve the app, and the
  token is saved for you. It acts as you, with the `repo` and `read:org`
  scopes. `repo` is GitHub's only scope for private repos, so it allows reading
  and writing all of them. The token doesn't expire, though GitHub revokes one
  left unused for a year. An organization that restricts OAuth app access has
  to approve Yarvis before it can see that org's repos.

  To sign in through a different OAuth App, set `YARVIS_GITHUB_CLIENT_ID`. A
  release build opened from Finder doesn't pass shell variables on, so this
  only works for a dev build or an app started from a shell. The app needs
  **Enable Device Flow** ticked, and no client secret.

  To paste a token instead: a classic PAT needs `repo` and `read:org`. A fine-grained PAT needs
  **Contents: Read** (the review reads file bodies to show context) plus pull
  request and issue access. Merging a stack needs write access to the repo.
  The review sync only sees reviews in repos the token can reach. An org that
  enforces SAML SSO also needs the token authorized for it. The sync's status
  under **Settings → Assistant** reports how many contributions were hidden.
  Add **Commit statuses: Read** to see legacy status checks. GitHub doesn't
  offer fine-grained tokens a Checks permission, so CI check runs can't be
  read with one: the PR still opens, and its **Checks** section says the
  token can't read them. The review workspace's verification checklist then
  shows no check annotations either. That checklist's code scanning row needs
  **Code scanning alerts: Read** on a fine-grained token; `repo` (or
  `security_events`) covers it for a signed-in token or a classic PAT. The row
  says so when the token can't read the alerts. A token used with an organization that enforces SAML
  SSO also has to be authorized for that org on GitHub.

  When GitHub refuses a request, the app says why: an expired or revoked
  token, an org that needs SSO authorization, a missing scope or permission,
  a private repo the token can't see, or a rate limit and when it resets.
  After a rate limit, Yarvis stops calling GitHub until the time GitHub gave.

  GitHub gives REST and GraphQL separate budgets. The reads Yarvis repeats
  most (the workspace poller, each PR row's status, issue lists and the
  signed-in account) go through GraphQL, so polling doesn't spend the REST
  budget. Most switch to REST while GraphQL is rate-limited or failing. The
  workspace poller switches only while GraphQL is failing: when GraphQL's
  limit is spent, it waits for the reset rather than spending the REST budget
  the PR pages need.
- **Azure DevOps.** A PAT with **Code (read & write)** and **Pull Request
  Threads (read & write)**. Code (read) is enough to browse and comment, but
  voting and publishing a draft write to the PR itself.
  Add **Work Items (read & write)** to use Azure Boards on the Issues
  tab. **Work Items (read)** also lets a review workspace's change map and
  claims checks read a PR's linked work items. Set the organization URL (`https://dev.azure.com/your-org`) under
  Settings → Credentials. The project is picked per search, so there is
  nothing else to set. Code search needs the **Code Search** extension
  installed in your organization. Without it, guided review still works, but
  the agent can't search the repo.
- **JIRA.** Atlassian Cloud only. Create the token at id.atlassian.com →
  Security → API tokens. Set your site URL (`https://your-org.atlassian.net`)
  and account email under Settings → Credentials. The same credentials let a
  review workspace's change map and claims checks read the Jira tickets a PR
  is for.

### Upgrading from an older build

Older builds stored one Keychain item per secret. Re-save each secret once in
Settings to fill the single item, then delete the old items in Keychain Access
if you like. The non-secret values that used to be in the Keychain (org URLs,
the JIRA email, the Google client id, the OTP window) move to
`~/.yarvis/settings.json` by themselves on the first launch. So does the old
`embeddings_provider_secrets` item, which is folded into the single item.
A `settings.json` that a build from before September 2026 left in the app's
data folder moves to `~/.yarvis/settings.json` when the app next starts its
local server, unless one is already there.

### Touch ID

Putting the Keychain item behind Touch ID needs a code-signed app with an
application-identifier entitlement. Dev builds aren't signed, so they fall back
to the login-password prompt. The 1Password store below gets you a Touch ID
prompt today, because the 1Password desktop app supplies it.

### 1Password instead of the Keychain

**Settings → Credentials → Secret store** moves the secrets item to a 1Password
item, named by vault and item title. The same JSON object is stored in the
item's notes field (`op://<vault>/<item>/notesPlain`), so every secret moves
together.

It needs the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`)
with the desktop app's CLI integration turned on. That integration is what puts
each read behind Touch ID. A GUI launch has a minimal `PATH`, so Yarvis also
looks in `/opt/homebrew/bin` and `/usr/local/bin`. Set `YARVIS_OP_BIN` if `op`
is somewhere else.

How switching works:

- Saving checks the vault is reachable and copies your current secrets to it.
  Only then does it record the choice. A mistyped vault leaves you on the store
  you were using.
- The item is created as a Secure Note if it doesn't exist.
- **A store that already holds secrets is never overwritten**, and the old
  store keeps its copy. Switching back doesn't copy anything, so the old store
  still has the values from before you switched. Settings tells you which
  case happened: copied, nothing to copy, or target already occupied.

Writes pass the secrets to `op` on standard input, never as command arguments.
Other processes can read command arguments with no prompt at all.

### Secrets on `yarvis-server`

`yarvis-server` can keep the secrets item in its own encrypted vault instead of
the Keychain or 1Password, for a server that starts before anyone logs in. It
is set in `server.toml`, not the Settings screen. `docs/client-server.md` has
the full setup and the API. When `server.toml` sets `[secrets] backend`,
**Settings → Credentials → Secret store** shows that store and offers no
switch, since the server refuses one; a pinned 1Password store still lets you
change its vault and item.

```toml
[secrets]
backend = "vault"

[ssh_agent]
enabled = true   # the server signs git commits with a key in the vault
```

- `yarvis-server vault init` asks for the vault passphrase (twice, with no
  echo; `--passphrase-stdin` reads it from stdin instead), creates
  `vault.json` in the server's data dir, and prints a recovery key once. Keep
  the key somewhere safe: it is the way in if you forget the passphrase.
- The vault passphrase is separate from the passphrase you sign in with, and
  has to be different: the vault refuses the sign-in one. Signing in proves who is asking the server; the vault
  passphrase decrypts `vault.json`, which anyone with a copy of the file can
  attack offline, so it is stretched harder and never stored.
- The vault starts locked every time the server starts. Unlock it with its
  passphrase or the recovery key. Until then the sidecar can't read its
  secrets. A wrong passphrase makes the next try wait, doubling up to 5
  minutes. Settings can't change the vault passphrase yet; the API can
  (`POST /api/vault/passphrase`, see `docs/client-server.md`).
- With `ssh_agent.enabled = true`, the server runs an ssh-agent while the
  vault is unlocked, and asks for an approval on every commit it signs.

**Work laptop: keep signing in 1Password.** Leave the vault off and keep the
key where it is:

```toml
[secrets]
backend = "onepassword"   # or "keychain"

[ssh_agent]
enabled = false           # the default
# Needed when launchd starts the server; written out in full, since ~ isn't expanded.
upstream_socket = "/Users/<you>/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

With `ssh_agent.enabled = false` the server never makes a signing key or opens
an agent socket. Workspace shells sign through 1Password's agent, which asks
for approval on the laptop itself.

### `PATH` for a server launchd starts

A server the desktop app starts gets your login shell's `PATH`. One that
launchd starts gets launchd's short one (`/usr/bin:/bin:/usr/sbin:/sbin`), so
the sidecar, terminals and agent sessions can't find `claude`, `git`, `gh` or
`bun` from Homebrew or mise. Set `path` under `[server]` in `server.toml` to
the `PATH` they should have:

```toml
[server]
# Written out in full, since ~ isn't expanded. `echo $PATH` in a terminal
# prints yours.
path = "/Users/<you>/.local/share/mise/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

The server gives it to the sidecar, which passes it on to the Claude Code runs
it starts, and to every terminal and agent session. It is also where a bare
`[sidecar] command` such as `bun` is looked up. Unset, they all inherit the
server's own `PATH`. A shell's rc files can still change it after it starts.
The server refuses to start when an entry is empty (a leading, trailing or
doubled `:`) or not an absolute path, since either is looked up from the
folder a process runs in, which for a session is a repo checkout.

### Where the server's sockets go

The server listens on two Unix sockets: `core-control.sock`, which the
sidecar uses, and, with `[ssh_agent] enabled`, `ssh-agent.sock`. A Unix socket
path must fit in about 104 bytes on macOS (108 on Linux). By default the
sockets go in the data dir, or in `~/.yarvis/run/<hash of the data dir>/` when
a path there would be too long. Set `socket_dir` under `[server]` to put them
somewhere else:

```toml
[server]
socket_dir = "/Users/<you>/.yarvis/sock"
```

It must be an absolute path. The server creates it with mode 0700 if it's
missing, but its parent folder must already exist. An existing folder must be a real folder (not a symlink), owned by
the user the server runs as, with mode 0700, or the server refuses to start.
The folders under `~/.yarvis/run` get the same checks, and `~/.yarvis` must be
owned by that user and not writable by anyone else. The server never uses a
temp folder, since macOS and systemd delete old files there. When no location
gives a short enough path, the server refuses to start and asks you to set
`socket_dir`.

## `~/.yarvis/settings.json`

This file holds everything you set from the Settings screen that isn't a
secret. Both the Rust core and the sidecar read and write it.

- A missing file, a missing key, or a malformed file all fall back to the
  built-in defaults. A fresh install needs no file at all.
- The directory is created `0700` and the file `0600`, because it can hold
  your JIRA email and similar.
- Writes are atomic (temp file, then rename).
- Every running copy of the app shares this file, including
  `bun run dev:instance` copies.

[`settings.example.json`](settings.example.json) is a starter file with every
common key set to its default (`null` also means "use the default"). Copy it into place if you want a file to edit by
hand:

```bash
mkdir -p ~/.yarvis && chmod 700 ~/.yarvis
cp -n docs/settings.example.json ~/.yarvis/settings.json
chmod 600 ~/.yarvis/settings.json
```

`cp -n` won't overwrite a file you already have. That matters, because the app
has written your providers and MCP servers into it.

### Keys the Rust core owns

| Key | Default | Meaning |
| --- | --- | --- |
| `agentName` | `"Claude"` | Title of a workspace's agent tab |
| `agentCommand` | `"claude --permission-mode auto"` | The command a workspace's agent session runs. Add a model or permission flags here. `YARVIS_CLAUDE_COMMAND` overrides it. |
| `agentHarnesses` | unset | Agent harnesses beyond the built-in one: `id`, `name`, `kind` (`claude-code`, `pi`, `opencode` or `custom`), `command`, `promptArgs`, `env` and `secretEnv` (names only; the values are in the secrets item). Set from Settings → Repositories → Agent; see [Workspaces](features/workspaces.md#agent-harnesses). |
| `defaultAgentHarness` | unset (`claude`, the built-in agent) | Id of the harness a session gets when none is picked. |
| `allowedSlashCommands` | unset | Slash commands or skills, beyond `/compact`, that the assistant may run in a workspace's agent session. Names without the `/`, e.g. `["do-code-review"]`. Set from Settings → Repositories → Agent. |
| `maxPtySessions` | `60` | Maximum number of open terminal sessions (1–1000) |
| `secretBackend` | `"keychain"` | `"keychain"` or `"onepassword"` |
| `onePasswordVault`, `onePasswordItem` | unset | Where the secrets item lives when using 1Password |
| `azureDevopsOrgUrl` | unset | `https://dev.azure.com/your-org` |
| `jiraBaseUrl` | unset | `https://your-org.atlassian.net` |
| `jiraEmail` | unset | The Atlassian account the JIRA token belongs to |
| `googleClientId` | unset | The Google OAuth client id. The secret half goes in the Keychain. |
| `telegramOtpWindowMinutes` | `120` | How long `/unlock` keeps the Telegram bot open |
| `colorTheme` | `"default"` | `"default"` or `"palenight"`. An unknown name falls back to the default. |
| `terminalFontSize` | `16` | Text size in every terminal (10–32). Cmd+= and Cmd+- change it. |
| `channelMessaging` | unset (off) | Experimental: lets the assistant message a workspace's agent session over a Claude Code channel and read its replies, instead of typing at its prompt. Also needs the channel flag in `agentCommand`. Set from Settings → Repositories → Agent; see [Workspaces](features/workspaces.md#messaging-a-session-over-a-channel-experimental). |
| `attentionAnimation` | `true` | `false` stops the amber band sweeping across the top bar and the bell shaking while the bell has something pending. The count badge still shows. |

`null` and a missing key both mean "use the default".

### Keys the sidecar owns

| Key | Holds | Set from |
| --- | --- | --- |
| `customProviders` | Your OpenAI-, Anthropic-, Ollama- or System One-compatible endpoints, keyed by id | Settings → LLM Providers |
| `providerModels` | Your edited model list per provider. Replaces the built-in list for that provider once saved. | Settings → LLM Providers → Models |
| `mcpServers` | MCP servers Yarvis connects to, keyed by id | Settings → Tools & MCP |
| `chatConfig` | `maxSteps` (100, up to 500), `maxOutputTokens` (none, up to 200000), `compactAtTokens` (200000, from 10000 to 2000000). A model's own compaction threshold in its catalog entry wins over `compactAtTokens`. | Settings → Assistant → Turn budget |
| `complexityModels` | The provider and model behind the `low`, `medium` and `max` tiers specialists can ask for | Settings → Assistant |
| `decisionModel` | `model`, the provider and model tagged `decision` that answers quick judgements, `autoApproveTools`, which lets it approve MCP tool calls before you are asked, and `autoApproveHeadsDown`, which lets it approve a heads-down call to an MCP tool you've approved in similar situations before (see [Heads-down mode](features/heads-down.md)), `routeComplexity`, which lets it pick the complexity tier for a specialist that names no model, and `pickSpecialists`, which lets it pick the specialist for a delegation that names none (see [Decision specialists](features/assistant.md#decision-specialists)) | Settings → Tools & MCP |
| `githubPrConfig` | `reviewQuery` for the Needs review tab, `reviewingLookbackDays` for Reviewing | Settings → PR review |
| `prModels` | The provider and model behind guided reviews (`guide`) and line questions (`ask`). Unset uses the default chat model. | Settings → PR review |
| `prVerification` | `sections`, the user's overrides of each verification check's Claude Code `model` (`sonnet`, `opus` or `haiku`) and `effort` (`low`, `medium`, `high`, `xhigh` or `max`), by section name; a check with no override runs on its default (Opus at high effort for `risk` and `malice`, Haiku at low effort for `comments` and `observability`, Sonnet at medium effort for the rest). A `model` saved before checks had their own is ignored. `harness`, the id of the Claude Code, OpenCode or Pi [agent harness](features/workspaces.md#agent-harnesses) the checks run with; left out, the built-in agent. `harnessModels`, by harness id, the model an OpenCode or Pi harness runs each tier on (`provider/model`, optionally OpenCode's `#variant` or Pi's `:level`): `opus`, `sonnet` and `haiku`. Also `maxBudgetUsd`, the budget one report is checked against (2 by default, at least 0.25, no upper limit). It only warns: when the assistant is asked for a report estimated over it, it asks before starting. The review workspace runs the checks you pick without asking, and a run that goes over it still finishes | Settings → PR review |
| `prRereview` | The "What's changed" re-review summary: its Claude Code `model` (`sonnet` by default), `maxBudgetUsd` (1 by default, at least 0.25, no upper limit; it only warns, like the verification report's), and `autoStart` (off by default), which starts it when the **Since last review** tab opens on changes it hasn't summarised | Settings → PR review |
| `mutationTesting` | Mutation testing in a review workspace: the Claude Code `planningModel` and `explanationModel` (`sonnet`; `null` uses Claude Code's default) with their budgets, `planningBudgetUsd` (1, at least 0.1) and `explanationBudgetUsd` (0.5, at least 0.05), `maxMutants` (12, up to 30) and `testTimeoutCapSeconds` (300, from 30 to 3600), the longest one test command may run. A mutant's tests get three times the baseline's time, at least 30 seconds, up to that cap. The budgets have no upper limit and stop nothing: they are shown before a pass starts, and a run that goes over them still finishes. | Settings → PR review |
| `wipConfig` | Which sources feed the **In progress** list in the attention panel (the bell in the top bar), and a GitHub issue label filter | Settings → Work in progress |
| `jobConfig` | `ccDigestEnabled` and `ccDigestProjectDirs` for the Claude Code transcript digest | Settings → Assistant |
| `headsDown` | Heads-down mode: `minSleepMinutes` (5), `maxSleepMinutes` (120) and `idleSleepMinutes` (60) between passes, `workingHours` (`days` with 0 for Sunday, `start` and `end` as `HH:MM`; Monday to Friday 09:00–17:00 by default; an end at or before the start runs past midnight; `null` for any time), which is also when it may tag people, `userAwayAfterMinutes` (120), `passTimeoutMinutes` (20, at most 240), how long one pass may run before it is stopped, the `provider` and `model` its passes run on (unset uses the default chat model), `guidance`, your standing rules for every pass in your own words (`null` for none), and `maxRoutinesPerPass` (2, from 0 to 10), the most routines one pass takes on (0 turns them off, meeting alarms included; routines themselves are files in `~/.yarvis/routines`), `alwaysOn` (false), which keeps a run going and starts one after a restart, `nightShift` (`start` and `end` as `HH:MM`, every day; `null`, the default, for none) with `nightShiftMinSleepMinutes` (120, at most 1440 and never past `maxSleepMinutes`), the shortest sleep in those hours, and `maxPassesPerDay` (`null` for no limit, at most 1440), the most passes started in one day. `shipMonitorWindowMinutes` (60 minutes, from 0 to 1440) is how long a ship stream watches production after its deploy, and `shipCheckEveryMinutes` (15 minutes, from 5 to 240) how often it checks in that time. Per machine, so a work laptop and a personal one can keep different hours. See [Heads-down mode](features/heads-down.md). | Heads down page |
| `voiceConfig` | Speech providers and models, voice, speak replies, continuous mode, the active saved voice (`activeVoiceId`, blank for none), and the Voice Studio's translation model (`translationProvider`, `translationModel`) | Settings → Voice, Voice page |
| `voiceProfiles` | Saved voices. Their cloning clips are files in `~/.yarvis/voices/`. | Voice page |
| `speechServer` | The local speech server's `port` (8000) | Voice page |
| `embeddingsConfig` | The embeddings endpoint | Settings → Embeddings |

Custom providers and MCP servers carry generated ids and timestamps. Add them
from the UI rather than by hand.

`githubPrConfig` and `jobConfig` are read as whole objects. If you edit them by
hand, include every field, as the example file does.

> **Known issue.** Saving a setting the Rust core owns (the agent command,
> the terminal cap, the Azure, JIRA, Google or Telegram fields, or the secret
> store) rewrites the file with only the Rust core's keys. That drops the
> sidecar's sections in the table above, such as your custom providers and
> voice setup. It also drops the `structuralSettingsMigrated` flag, so the
> next sidecar start re-runs a one-time migration that copies older settings
> from Postgres back into the file. Back up the file before changing those
> fields.


## Embeddings

Memory search uses vector embeddings stored in the `memories.embedding` column,
which is `vector(1536)`. Yarvis asks the embeddings provider for 1536
dimensions, so the model must either produce 1536 natively or support
shortened output (Matryoshka models such as Qwen3, Gemini and OpenAI's
`text-embedding-3` do).

Yarvis picks the embedder in this order:

1. The endpoint under **Settings → Embeddings**, if one is set. It must be
   OpenAI-compatible, for example a LiteLLM gateway in front of Gemini
   (`http://localhost:4000/v1`, model `gemini-embedding-001`) or a local Qwen3
   embedding server.
2. Gemini directly, if a Gemini key is saved.
3. An offline hash embedder. It works with no setup, but recall quality is much
   lower.

Each memory records which embedder made its vector. When you change
providers, Settings → Embeddings warns that some memories were made by a
different embedder. **Re-embed all** there (or `POST /api/memory/reembed`)
regenerates every vector.

## Google Calendar on a server you reach remotely

When yarvis-server's `auth.origins` lists an `https` origin that isn't
`localhost` (a server behind `tailscale serve`, say), Google's sign-in
redirects to `https://<that origin>/api/oauth/google/callback` instead of the
sidecar's loopback port. The server forwards it to the sidecar, which accepts
only a sign-in it started. A "Desktop app" client can't use that redirect, so
such a server needs a "Web application" client:

1. In the [Google Cloud Console](https://console.cloud.google.com), open
   **APIs & Services → Credentials** in the project with the Google Calendar
   API enabled, and choose **Create credentials → OAuth client ID**.
2. Pick **Web application** as the application type.
3. Under **Authorized redirect URIs**, add
   `https://<your server's origin>/api/oauth/google/callback`, with the host
   in lowercase and no `:443` (Google matches it character for character).
   The origin is the first `https` one in `auth.origins` that isn't loopback.
4. Create it, then enter its client ID and secret in **Settings →
   Credentials** as for a Desktop client (`googleClientId` and
   `google_client_secret`). Connect again from the Calendar tab.

Which kind of client the server expects follows from its config: an `https`
origin off loopback means Web application, none means Desktop app. Changing
`auth.origins` either way means switching the client too.

Google only accepts an `https` redirect whose host ends in a domain on the
[Public Suffix List](https://publicsuffix.org/), and refuses raw IP
addresses. `ts.net` is on that list (in its private section, added by
Tailscale), so a `<machine>.<tailnet>.ts.net` name from `tailscale serve`
meets the rule. Nobody has tried one against Google yet, so if the console
refuses it, use a domain you own.

## Environment variables

You don't need any of these for normal use. They are for running more than one
copy of the app, or for debugging.

| Variable | Effect |
| --- | --- |
| `YARVIS_WORKSPACES_ROOT` | Where workspace clones and worktrees go. Default `~/dev/yarvis-workspaces`. |
| `YARVIS_DATABASE_URL` | The Postgres database the server and the sidecar use. Wins over `[database] url` in `server.toml`. |
| `YARVIS_CLAUDE_COMMAND` | Overrides `agentCommand` |
| `YARVIS_OP_BIN` | Path to the 1Password `op` binary |
| `YARVIS_INSTANCE` | Names this process as a secondary instance. Use `bun run dev:instance` instead of setting this by hand. |
| `YARVIS_BACKGROUND_WORKERS` | `1` or `0`: whether this instance runs the pollers, jobs and Telegram bot |
| `YARVIS_GITHUB_CLIENT_ID` | The OAuth App that **Sign in with GitHub** uses, in place of the built-in one. The app needs **Enable Device Flow** ticked. |
| `YARVIS_GLOBAL_SHORTCUTS` | `1` or `0`: whether this instance owns the global hotkeys |
| `YARVIS_DEV_PORT` | Pin the Vite dev-server port. Default 1420. |
| `YARVIS_DEBUG_MCP` | `1` logs raw MCP server replies |
| `YARVIS_DEBUG_MEMORY` | `1` logs memory store operations |
| `YARVIS_SETTINGS_PATH` | A different settings file, for the sidecar only. The Rust core ignores it. |
| `YARVIS_AGENTS_DIR` | A different directory for your specialist definitions. Default `~/.yarvis/agents`. |
| `YARVIS_ROUTINES_DIR` | A different directory for your heads-down routines. Default `~/.yarvis/routines`. |
| `YARVIS_LOG_DEV_TOKEN` | `1` makes a standalone sidecar (`bun run sidecar:dev`) print its API token instead of a fingerprint |
| `TAURI_DEV_HOST` | Serve the Vite dev server on this host. Also turns on the HMR socket port. |
| `CLAUDE_HOME` | Where Claude Code keeps sessions. Default `~/.claude`. |
| `AWS_PROFILE`, `AWS_REGION`, … | The usual AWS credential chain, for Bedrock |
| `YARVIS_GITHUB_API_URL`, `YARVIS_GITHUB_GRAPHQL_URL` | Send GitHub REST and GraphQL requests to a local stand-in, such as the demo's fake GitHub. Set both or neither. |
| `YARVIS_GOOGLE_CALENDAR_API_URL`, `YARVIS_GOOGLE_TOKEN_URL` | Send Google Calendar API and OAuth token requests to a local stand-in. Set both or neither. The Calendar value is a base, e.g. `http://127.0.0.1:4010/calendar/v3`. |

The four endpoint overrides are for a sidecar you start yourself, as the demo
recordings do (`demo/README.md`). The app strips them before it starts its
sidecar, since they decide where your GitHub token and Google credentials go.
The sidecar also refuses any value that isn't a plain `http://` or `https://`
URL on `localhost`, `127.0.0.1` or `[::1]`, and ignores half a pair, logging a
warning either way.

The sidecar inherits the environment of the shell that started the app. A
provider key exported in that shell reaches the sidecar unless the Keychain
has its own value for it. A `DATABASE_URL` there is ignored: the server sets
the sidecar's from its own database URL. A release build opened from
Finder has no such shell: it only takes `PATH` from your login shell, and the
other variables above don't reach it. A server launchd starts gets neither, so
set `[server] path` for it (see
[`PATH` for a server launchd starts](#path-for-a-server-launchd-starts)).

## Settings screen map

The tabs in **Settings**, in order:

1. **Credentials.** Secret store choice, the secrets list, and the non-secret
   integration fields (Azure org URL, JIRA URL and email, Google client id).
2. **LLM Providers.** Each provider's model list and capability tags, and your
   custom providers.
3. **Tools & MCP.** The decision model (auto mode, picking specialists and
   model tiers, and a playground to try it), MCP servers Yarvis
   connects to, Yarvis's own MCP endpoint, and the Tool manager, whose tool
   groups start collapsed.
4. **Repositories.** The repos workspaces can use, with each repo's setup and
   run scripts, ticket tracker and playbooks (a prompt of up to 4000
   characters for each step of shipping a PR, from CI and review to
   deploying, monitoring and reverting; they live with the repo in the
   database, not in `settings.json`, and agents read them only through the
   `get_repo_playbook` tool; see
   [Repo playbooks](features/workspaces.md#repo-playbooks)), the workspace
   agent command, and the terminal cap.
5. **PR review.** The Needs review search, the Reviewing lookback, the
   models behind guided reviews and line questions, and the model, budget and
   mutant cap for mutation testing.
6. **Voice.** Speech to text and text to speech.
7. **Embeddings.** The embeddings endpoint.
8. **Telegram.** Bot token, allowed chats, and the optional second factor.
9. **Work in progress.** Which sources feed the **In progress** list in the
   attention panel: your open PRs, starred PRs, guided reviews you haven't
   finished, issues, today's tasks and active workspaces.
10. **Assistant.** Turn budget, complexity tiers, specialists, and background
    jobs.
11. **Devices.** The devices signed in to the server, revoking one, creating a
    token to pair a client that can't sign in itself, the account (passphrase,
    authenticator app, backup codes, signing out other devices), and the
    approvals waiting
    on an answer. See [Signing in and devices](features/devices.md).
12. **Appearance.** The color theme: **Default** or **Palenight**. It applies
    straight away, to terminals and code too, and is saved as `colorTheme` in
    `settings.json`. Below it, a toggle turns off the amber band that sweeps
    across the top bar and the bell's shake while the bell has something
    pending, saved as `attentionAnimation`.
13. **Diagnostics.** The sidecar log.
