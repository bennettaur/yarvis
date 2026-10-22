# yarvis-review

A Claude Code plugin that Yarvis loads into the headless runs behind its PR
review workspaces (`claude -p --plugin-dir <dir>`).

This folder is the source. The sidecar embeds every file listed in
`sidecar/src/agentRuns/plugins.ts` into its binary and writes them to
`~/.yarvis/claude-plugins/yarvis-review/` before a run, rewriting that copy
whenever the bundled content changes. Editing the copy under `~/.yarvis` does
nothing lasting.

To add an agent or a skill, put its file here in Claude Code's plugin layout
(`agents/<name>.md`, `skills/<name>/SKILL.md`) and add it to the plugin's file
list in `plugins.ts`. A file that isn't listed there never reaches the run.

To try the plugin by hand against a checkout:

```bash
claude --plugin-dir sidecar/claude-plugins/yarvis-review
```
