# AGENTS.md: the Android app

Read the repo root's `AGENTS.md` first; this adds what is specific to this
folder.

- This client is deliberately small: chat, the attention bell, workspaces
  and terminals (see `README.md`). Changes to those on the web UI or in the
  API they read land here in the same PR, with the same labels and rules. If they can't, the PR
  says so and an issue tracks it. Other pages stay in the web UI.
- The toolchain is pinned in this folder's `mise.toml`; build and test as the
  README describes.
