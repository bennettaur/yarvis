# Demo recordings

Drives the real Yarvis UI in Chromium with Playwright and saves screenshots
and a video of each flow. Use it for docs, the showcase deck
(`docs/showcase/`), and release notes, instead of clicking through the app by
hand.

```bash
bun run demo                 # every flow in demo/flows/
bun run demo -g tour         # one flow, by title
bun run demo flows/chat.demo.ts  # one flow, by file
bun run demo --headed        # watch it run
bun run demo:site            # turn the last run into a static site in demo/site/
```

The `Demo site` workflow (`.github/workflows/demo-pages.yml`) records every
flow each morning (Toronto time) and publishes the result, with the showcase
deck and the showcase video's player (`video/`, see `video/README.md`), to
GitHub Pages at https://bennettaur.github.io/yarvis/. Run it from the
Actions tab to publish straight away; only runs on `main` publish. It needs
the repo's Pages source set to GitHub Actions (Settings → Pages), which it is.
A run where any flow fails publishes nothing, so the site keeps the last good
recording, and the failed flows' Playwright traces are kept for a week as the
`demo-failures` artifact. Screenshots from CI use Linux's fonts, so they
differ a little from a run on a Mac.

The flows in `demo/flows/` cover the Chat tab (including a tool call that
creates a task), Omni Chat, the Omni layout builder, GitHub PRs and issues,
the Calendar, the Terminal tab, a workspace's Claude Code session, and a short
tour.

Output lands in `demo/output/<flow-title>/`, with the test's title lowercased
and hyphenated ("Memory library" becomes `memory-library/`). It holds numbered
PNGs (`01-tasks.png`, `02-task-added.png`, …) at 2x scale, plus `video.webm` of
the whole flow. The directory is gitignored.

Before the first run:

- Install Playwright's Chromium: `bunx playwright install chromium`.
- Have Node on your PATH. Playwright's runner runs under Node, not Bun.
- Have Postgres with pgvector running locally (see `docs/getting-started.md`).

## What's real and what isn't

The React frontend and the sidecar are real. Data goes through the sidecar's
HTTP API into Postgres, exactly as in the app. These are faked:

- **The Rust core** is replaced by `tauriMock.ts`, because Tauri's macOS
  webview (WKWebView) can't be driven by Playwright or WebDriver. Native things
  don't appear: the window frame, the tray, OS notifications, global hotkeys. A
  flow can fire the events they would send (`demo.fireAlarm`,
  `demo.emit("omni-chat-summon")`).
- **The chat model** is `fakeLlm/`, a local server that speaks the OpenAI
  chat-completions API. It's registered with the sidecar as an ordinary custom
  provider ("Demo model"), and every chat surface is set to use it. It answers
  from the canned replies in `fakeLlm/script.ts`, streamed so the reply is seen
  being written. A reply can call one of the sidecar's tools, which then runs
  for real: the chat flow's `create_task` call puts a real task on the list.
- **GitHub and Google Calendar** are `fakeGithub/` and `fakeGoogle/`, local
  servers the sidecar reaches through its `YARVIS_GITHUB_*` and
  `YARVIS_GOOGLE_*` endpoint overrides (see `docs/configuration.md`). The PRs
  tab, PR review, Issues and the Calendar views all show their data, which
  lives in `fakeGithub/data.ts` and `fakeGoogle/server.ts`. Calendar events are
  laid out around today. The Stack tab and merging a workspace's stack use the
  `gh` CLI, which isn't faked.
- **Terminals** are `fakeShell.ts`: each one shows a prompt, echoes keys, and
  prints canned output for the commands in `COMMANDS` (`git status`,
  `bun test`, …). Typing `claude`, or opening a workspace, starts a scripted
  Claude Code session that answers any instruction the same way.

## Canned replies

`fakeLlm/script.ts` holds a list of replies. The first one whose `when` matches
the user's latest message is used, so put specific patterns first. A reply has
either `text`, or a `toolCall` plus the `after` text the model says once the
tool has run. Replies with `surface: "omni"` answer the Omni tab's layout
builder instead of chat. Their text is one line of prose followed by a
` ```spec ` block of JSON patches, the format Omni's system prompt asks for.
Widgets there fetch their own data, so pick ones with something to show: Tasks,
Memory and WorkspaceList (filled by the seed), PullRequests and the Calendar
widgets (the fake GitHub and Google), and Terminal (the scripted shell). Alarms
is empty unless the flow fires one with `demo.fireAlarm`.

A message no reply matches gets a placeholder answer, which is easy to spot in
a screenshot. A reply may only call tools listed in `SAFE_TOOLS`, ones that
touch nothing but the demo database, since the sidecar runs the call for real.
If the tool isn't listed, or the sidecar didn't offer it that turn, the server
logs `[fake-llm]` and answers in text.

## The demo stack

`globalSetup.ts` brings everything up once per run (`stack.ts`):

1. Drops and recreates the `yarvis_demo` database. Override it with
   `YARVIS_DEMO_DATABASE_URL`. Since this step deletes the database, the
   runner only accepts a local one with "demo" in its name, and refuses query
   parameters such as `?dbname=` that would point the sidecar elsewhere.
2. Starts the fake model, GitHub and Google, the sidecar against that
   database, and Vite. The
   sidecar's `HOME`, `settings.json`, agents directory and `CLAUDE_HOME` point
   into `demo/output/.state/`, so your real memories, sessions and workspaces
   never show up in a screenshot. Workspaces go in `/tmp/yarvis-demo/`, since
   the app shows a workspace's full path. Background workers are off.
3. Seeds the database with made-up data from `seed.ts`: tasks, memories, a
   provisioned "Payment step" workspace, the fake GitHub repo for the Issues
   tab, and a Google token so Calendar shows as connected.

Run one demo at a time per machine: runs share the demo database and
`/tmp/yarvis-demo/`, and each run starts by wiping both.

Each flow then opens `demo/index.html`, which installs the Tauri mock and then
loads the normal app. A flow fails if the app calls a Tauri command the mock
doesn't answer, so a new command shows up as a failure instead of a broken
screenshot. Set `DEMO_VERBOSE=1` to see the sidecar and Vite logs.

## Writing a flow

A flow is a Playwright test in `demo/flows/<name>.demo.ts`. Write the demo as a
plain list of steps first ("open Tasks, add 'Send the rollout plan', show the
list"), then turn it into a flow. The `demo-flow` skill in `.claude/skills/`
does that conversion. A flow only needs updating when the UI it touches
changes.

```ts
import { expect, test } from "../fixture";

test("tasks", async ({ demo, page }) => {
  await demo.openTab("Tasks");
  await demo.type(page.getByPlaceholder("Add a task..."), "Send the rollout plan");
  await demo.click(page.getByRole("button", { name: "Add", exact: true }));
  await expect(page.getByText("Send the rollout plan")).toBeVisible();
  await demo.shot("task added");
});
```

The `demo` helpers in `fixture.ts` are made to look good on video. The
cursor is drawn by the page (Playwright's video shows none), glides to each
target, and ripples on click. Typing goes one key at a time.

| Helper | Does |
| --- | --- |
| `openTab(label)` | Clicks a nav rail tab by its label. |
| `click(locator)` | Moves the cursor to the element and clicks it. |
| `type(locator, text)` | Clicks into a field and types at a readable speed. |
| `press(key)` | Presses a key, e.g. `"Enter"`. |
| `hover(locator)` | Moves the cursor without clicking. |
| `pause(ms)` | Holds still so a viewer can take in the screen. |
| `shot(name, { target, cursor })` | Saves the next numbered PNG. Pass `target` to capture one element. The cursor is hidden unless `cursor: true`. |
| `fireAlarm(alarm)` | Rings an alarm, as the core's scheduler would. |
| `emit(event, payload)` | Fires any other native event the UI listens for. |

To type into a terminal, click it (`demo.click(page.locator(".xterm").first())`),
then use `page.keyboard.type(...)` and `demo.press("Enter")`. The terminal's
text is in the DOM, so `expect(page.getByText(...))` can wait for output.

Use `expect(...)` to wait for the result of an action before taking a shot.
Otherwise the shot can catch the screen mid-update.

Videos and screenshots record everything typed on screen. Never type a real
key, token or personal detail into a flow. Use obvious placeholders such as
`sk-ant-demo-0000`.

To add data that every flow can use, extend `seed.ts`. Data only one flow
needs can be created in that flow, through the UI or with `page.request`. Flows
run one after another against the same database, so a flow sees what earlier
ones created. Give anything a flow adds a name no other flow uses.
