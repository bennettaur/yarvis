# Configuration

Yarvis keeps its configuration in three places, split by what the value is:

| Kind | Where | Set from |
| --- | --- | --- |
| Secrets: the database URL, API keys, tokens | One item in the macOS Keychain, or in 1Password | **Settings → Credentials** |
| Everything else you change from the UI | `~/.yarvis/settings.json` | The Settings screen, or by hand |
| Machine-level overrides | Environment variables | Your shell, before `bun run tauri dev` |

Your data (chat history, memory, tasks, workspaces, PR notes) isn't
configuration. It lives in Postgres.

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
| Database URL | Everything stored in Postgres | `DATABASE_URL` |
| Anthropic API key | Claude chat | `ANTHROPIC_API_KEY` |
| Gemini API key | Gemini chat, embeddings, cloud voice | `GEMINI_API_KEY` |
| Cerebras API key | Cerebras chat | `CEREBRAS_API_KEY` |
| Hugging Face token | Cloud speech to text | `HUGGINGFACE_API_KEY` |
| GitHub token | PRs, issues, stacks | `GITHUB_TOKEN` |
| Azure DevOps token | Azure PRs, Azure Boards | `AZURE_DEVOPS_TOKEN` |
| JIRA API token | JIRA issues | `JIRA_API_TOKEN` |
| Google client secret | Google Calendar | `GOOGLE_CLIENT_SECRET` |
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

- **GitHub.** A classic PAT needs `repo`. A fine-grained PAT needs
  **Contents: Read** (the review reads file bodies to show context) plus pull
  request and issue access. Merging a stack needs write access to the repo.
- **Azure DevOps.** A PAT with **Code (read & write)** and **Pull Request
  Threads (read & write)**. Code (read) is enough to browse and comment, but
  voting and publishing a draft write to the PR itself.
  Add **Work Items (read & write)** to use Azure Boards on the Issues
  tab. Set the organization URL (`https://dev.azure.com/your-org`) under
  Settings → Credentials. The project is picked per search, so there is
  nothing else to set. Code search needs the **Code Search** extension
  installed in your organization. Without it, guided review still works, but
  the agent can't search the repo.
- **JIRA.** Atlassian Cloud only. Create the token at id.atlassian.com →
  Security → API tokens. Set your site URL (`https://your-org.atlassian.net`)
  and account email under Settings → Credentials.

### Upgrading from an older build

Older builds stored one Keychain item per secret. Re-save each secret once in
Settings to fill the single item, then delete the old items in Keychain Access
if you like. The non-secret values that used to be in the Keychain (org URLs,
the JIRA email, the Google client id, the OTP window) move to
`~/.yarvis/settings.json` by themselves on the first launch. So does the old
`embeddings_provider_secrets` item, which is folded into the single item.

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
| `maxPtySessions` | `60` | Maximum number of open terminal sessions (1–1000) |
| `secretBackend` | `"keychain"` | `"keychain"` or `"onepassword"` |
| `onePasswordVault`, `onePasswordItem` | unset | Where the secrets item lives when using 1Password |
| `azureDevopsOrgUrl` | unset | `https://dev.azure.com/your-org` |
| `jiraBaseUrl` | unset | `https://your-org.atlassian.net` |
| `jiraEmail` | unset | The Atlassian account the JIRA token belongs to |
| `googleClientId` | unset | The Google OAuth client id. The secret half goes in the Keychain. |
| `telegramOtpWindowMinutes` | `120` | How long `/unlock` keeps the Telegram bot open |

`null` and a missing key both mean "use the default".

### Keys the sidecar owns

| Key | Holds | Set from |
| --- | --- | --- |
| `customProviders` | Your OpenAI- or Anthropic-compatible endpoints, keyed by id | Settings → LLM Providers |
| `providerModels` | Your edited model list per provider. Replaces the built-in list for that provider once saved. | Settings → LLM Providers → Models |
| `mcpServers` | MCP servers Yarvis connects to, keyed by id | Settings → Tools & MCP |
| `chatConfig` | `maxSteps` (100, up to 500), `maxOutputTokens` (none, up to 200000), `compactAtTokens` (200000, from 10000 to 2000000). A model's own compaction threshold in its catalog entry wins over `compactAtTokens`. | Settings → Assistant → Turn budget |
| `complexityModels` | The provider and model behind the `low`, `medium` and `max` tiers specialists can ask for | Settings → Assistant |
| `githubPrConfig` | `reviewQuery` for the Needs review tab, `reviewingLookbackDays` for Reviewing | Settings → PR review |
| `wipConfig` | Which sources feed the **In progress** list in the attention panel (the bell in the top bar), and a GitHub issue label filter | Settings → Work in progress |
| `jobConfig` | `ccDigestEnabled` and `ccDigestProjectDirs` for the Claude Code transcript digest | Settings → Assistant |
| `voiceConfig` | Speech providers and models, voice, speak replies, hands-free | Settings → Voice |
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

## Environment variables

You don't need any of these for normal use. They are for running more than one
copy of the app, or for debugging.

| Variable | Effect |
| --- | --- |
| `YARVIS_WORKSPACES_ROOT` | Where workspace clones and worktrees go. Default `~/dev/yarvis-workspaces`. |
| `YARVIS_DATABASE_URL` | Overrides the database URL from the Keychain, for this process only |
| `YARVIS_CLAUDE_COMMAND` | Overrides `agentCommand` |
| `YARVIS_OP_BIN` | Path to the 1Password `op` binary |
| `YARVIS_INSTANCE` | Names this process as a secondary instance. Use `bun run dev:instance` instead of setting this by hand. |
| `YARVIS_BACKGROUND_WORKERS` | `1` or `0`: whether this instance runs the pollers, jobs and Telegram bot |
| `YARVIS_GLOBAL_SHORTCUTS` | `1` or `0`: whether this instance owns the global hotkeys |
| `YARVIS_DEV_PORT` | Pin the Vite dev-server port. Default 1420. |
| `YARVIS_DEBUG_MCP` | `1` logs raw MCP server replies |
| `YARVIS_DEBUG_MEMORY` | `1` logs memory store operations |
| `YARVIS_SETTINGS_PATH` | A different settings file, for the sidecar only. The Rust core ignores it. |
| `YARVIS_AGENTS_DIR` | A different directory for your specialist definitions. Default `~/.yarvis/agents`. |
| `YARVIS_LOG_DEV_TOKEN` | `1` makes a standalone sidecar (`bun run sidecar:dev`) print its API token instead of a fingerprint |
| `TAURI_DEV_HOST` | Serve the Vite dev server on this host. Also turns on the HMR socket port. |
| `CLAUDE_HOME` | Where Claude Code keeps sessions. Default `~/.claude`. |
| `AWS_PROFILE`, `AWS_REGION`, … | The usual AWS credential chain, for Bedrock |

The sidecar inherits the environment of the shell that started the app. A
`DATABASE_URL` or provider key exported in that shell reaches the sidecar
unless the Keychain has its own value for it. A release build opened from
Finder has no such shell: it only takes `PATH` from your login shell, and the
other variables above don't reach it.

## Settings screen map

The tabs in **Settings**, in order:

1. **Credentials.** Secret store choice, the secrets list, and the non-secret
   integration fields (Azure org URL, JIRA URL and email, Google client id).
2. **LLM Providers.** Each provider's model list and capability tags, and your
   custom providers.
3. **Tools & MCP.** MCP servers Yarvis connects to, Yarvis's own MCP endpoint,
   and the Tool manager.
4. **Repositories.** The repos workspaces can use, the workspace agent
   command, and the terminal cap.
5. **PR review.** The Needs review search and the Reviewing lookback.
6. **Voice.** Speech to text and text to speech.
7. **Embeddings.** The embeddings endpoint.
8. **Telegram.** Bot token, allowed chats, and the optional second factor.
9. **Work in progress.** Which sources feed the **In progress** list in the
   attention panel.
10. **Assistant.** Turn budget, complexity tiers, specialists, and background
    jobs.
11. **Diagnostics.** The sidecar log.
