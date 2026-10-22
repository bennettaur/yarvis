# yarvis-review

A Claude Code plugin that Yarvis loads into the headless runs behind its PR
review workspaces (`claude -p --plugin-dir <dir>`).

This folder is the source. The sidecar embeds every file listed in
`sidecar/src/agentRuns/plugins.ts` into its binary and writes a fresh copy to a
private temp directory for each run, removed when the run ends.

The verification report is the `verification-report` skill, which runs the
agents in `agents/` (summary and must-reads, risk, completeness, tests,
complexity, performance, comments) in parallel and merges their answers. Its
run starts from `sidecar/src/reviewWorkspaces/verification.ts`, which writes
the PR's context and numbered diff to a directory the run may read.

To add an agent or a skill, put its file here in Claude Code's plugin layout
(`agents/<name>.md`, `skills/<name>/SKILL.md`) and add it to the plugin's file
list in `plugins.ts`. A file that isn't listed there never reaches the run.

To try the plugin by hand against a checkout:

```bash
claude --plugin-dir sidecar/claude-plugins/yarvis-review
```
