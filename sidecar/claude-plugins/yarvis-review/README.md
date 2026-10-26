# yarvis-review

A Claude Code plugin that Yarvis loads into the headless runs behind its PR
review workspaces (`claude -p --plugin-dir <dir>`).

This folder is the source. The sidecar embeds every file listed in
`sidecar/src/agentRuns/plugins.ts` into its binary and writes a fresh copy to a
private temp directory for each run, removed when the run ends.

The verification report is the `verification-report` skill, which runs the
agents in `agents/` (summary and must-reads, risk, completeness, tests,
complexity, performance, comments) in parallel and assembles their answers.
Its run starts from `sidecar/src/reviewWorkspaces/verification.ts`, which
writes the PR's context and numbered diff to a directory the run may read, and
removes duplicate findings across sections once the run answers.

Every agent takes its inputs and trust rules from `shared/inputs-and-trust.md`,
which `plugins.ts` puts in place of the `<!-- yarvis-review:inputs-and-trust -->`
line when it writes a run's copy. Claude Code has no include for agent files,
and the system prompt a run appends doesn't reach subagents, so this is how
each agent gets the same guardrail.

To add an agent or a skill, put its file here in Claude Code's plugin layout
(`agents/<name>.md`, `skills/<name>/SKILL.md`) and add it to the plugin's file
list in `plugins.ts`. A file that isn't listed there never reaches the run.

To try the plugin by hand against a checkout, use a copy `writePluginCopy`
wrote, since the agents here lack the shared section:

```bash
claude --plugin-dir <copy>/yarvis-review
```
