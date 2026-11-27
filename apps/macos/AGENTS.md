# AGENTS.md: the macOS app

Read the repo root's `AGENTS.md` first; this adds what is specific to this
folder.

- The Mac app keeps feature parity with the web UI for every page it builds
  natively (see `README.md`). A feature added to one of those pages on the web
  lands here in the same PR, with the same labels and rules, and the other
  way round. If it can't, the PR says so and an issue tracks it.
- Logic a test can reach goes in `Sources/YarvisClient`, with its tests in
  `Tests/YarvisClientTests`; views go in `Sources/YarvisMac`. Reuse the web
  implementation's wording rather than writing new copy.
- Build and test from this folder with `swift build` and `swift test`.
  `docs/native-macos.md` maps the server API to Swift; update it with the
  code.
