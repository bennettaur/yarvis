# Demo recordings

Drives the real Yarvis UI in Chromium with Playwright and saves screenshots
and a video of each flow. Use it for docs, the showcase deck
(`docs/showcase/`), and release notes, instead of clicking through the app by
hand.

```bash
bun run demo                 # every flow in demo/flows/
bun run demo -g tour         # one flow, by title
bun run demo --headed        # watch it run
```

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
HTTP API into Postgres, exactly as in the app.

The Rust core is replaced by `tauriMock.ts`, because Tauri's macOS webview
(WKWebView) can't be driven by Playwright or WebDriver. Because of that:

- Terminals and workspace agent sessions open empty. They are PTYs in the Rust
  core. A flow can write into one with
  `demo.emit("pty-output:<id>", { offset, bytes })`, the shape in `src/lib/pty.ts`.
- Native things don't appear: the window frame, the tray, OS notifications,
  global hotkeys. A flow can fire the events they would send (`demo.fireAlarm`,
  `demo.emit("omni-chat-summon")`).
- Chat replies need a provider key. Set `ANTHROPIC_API_KEY` (or
  `GEMINI_API_KEY`, `CEREBRAS_API_KEY`) in the shell running `bun run demo` and
  it's passed to the sidecar. Apart from `PATH` and `USER`, no other env var
  from your shell reaches it.

## The demo stack

`globalSetup.ts` brings everything up once per run (`stack.ts`):

1. Drops and recreates the `yarvis_demo` database. Override it with
   `YARVIS_DEMO_DATABASE_URL`. Since this step deletes the database, the
   runner only accepts a local one with "demo" in its name, and refuses query
   parameters such as `?dbname=` that would point the sidecar elsewhere.
2. Starts the sidecar against that database, and Vite. The sidecar's `HOME`,
   `settings.json`, agents directory, workspaces root and `CLAUDE_HOME` all
   point into `demo/output/.state/`, so your real memories, sessions and
   workspaces never show up in a screenshot. Background workers are off.
3. Seeds the database with made-up data from `seed.ts`.

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

Use `expect(...)` to wait for the result of an action before taking a shot.
Otherwise the shot can catch the screen mid-update.

Videos and screenshots record everything typed on screen. Never type a real
key, token or personal detail into a flow. Use obvious placeholders such as
`sk-ant-demo-0000`.

To add data that every flow can use, extend `seed.ts`. Data only one flow
needs can be created in that flow, through the UI or with `page.request`.
