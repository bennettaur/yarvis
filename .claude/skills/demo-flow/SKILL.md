---
name: demo-flow
description: Turn a plain-English demo script into a Playwright demo flow under demo/flows/, run it, and check the screenshots and video it produces. Use when someone wants screenshots or a video of Yarvis, asks to record a demo, or hands over a list of steps to show in the app.
---

# Write and record a demo flow

The demo harness is described in `demo/README.md`. Read it first. It drives
the real frontend in Chromium against a seeded sidecar, with the Rust core
mocked by `demo/tauriMock.ts`.

## Steps

1. Get the script: a list of steps to show, and the screenshots wanted. If the
   user gave only a goal ("show off memory"), write the steps yourself and
   confirm them before going on.
2. Check each step against what the harness can show. Chat replies come from
   `demo/fakeLlm/script.ts` (which also holds what a voice recording
   transcribes to), terminal output from `demo/fakeShell.ts`, GitHub from
   `demo/fakeGithub/data.ts`, JIRA from `demo/fakeJira/data.ts`, calendar
   events from `demo/fakeGoogle/server.ts`, clipboard history from
   `demo/tauriMock.ts`, and the seeded workspace's code from
   `demo/seedRepo.ts`. A step that needs something those don't have yet needs
   it added there first. Native UI (window frame, tray, OS notifications) and the `gh`-backed
   Stack tab can't be shown. If a step depends on one of those, say so and
   offer an alternative before writing it.
3. Find the selectors in the components under `src/components/`. Prefer, in
   order: `getByRole` with the accessible name, `getByPlaceholder`,
   `getByText`. Avoid CSS classes, since Tailwind classes change often. The
   exceptions have no accessible name: for a terminal use
   `page.locator(".xterm").filter({ visible: true })`, and for a diff row
   `demo.diffLine(text)`.
4. Write `demo/flows/<name>.demo.ts` with the `demo` helpers from
   `demo/fixture.ts`. Never type a real key, token or personal detail; the
   video records it. After every action that changes the screen, wait for the
   result with `expect(...).toBeVisible()` before calling `demo.shot`. If the
   flow needs data the seed lacks, add it to `demo/seed.ts` when other flows
   could use it too. Otherwise create it in the flow.
5. Run it: `bun run demo -g "<test title>"`. It connects to the local Postgres
   server, which the command sandbox blocks, so run it with the sandbox
   disabled.
6. Look at every PNG in `demo/output/<title>/`, where the title is lowercased
   and hyphenated ("Memory library" becomes `memory-library/`). Check that
   each one shows what its step promised: no loading spinners, no error
   banners, nothing cut off.
   Fix the flow and rerun until they do.
7. Report the output path. Mention any step that couldn't be shown as
   written.
