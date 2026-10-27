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
writes the PR's context, an `index.md` of every changed file and one numbered
patch per file (`patches/<path>.diff`, `reviewWorkspaces/patchFiles.ts`) to a
directory the run may read, marks bulk to skim, and splits the rest into
reading groups no bigger than one agent can hold; on a big PR the skill runs
each check once per group. Once the run answers it removes duplicate
findings across sections and adds which changed files no agent read
(`reviewWorkspaces/coverage.ts`, from the run's Read calls).

The "What's changed" re-review summary is the `rereviewer` agent alone, run as
the main thread (`--agent yarvis-review:rereviewer`). Its run starts from
`sidecar/src/reviewWorkspaces/rereview.ts`, which writes the reviewer's
comments and one numbered interdiff per file changed since their last review,
laid out the same way, and checks the answer against them and against what
the agent read.

Every verification agent takes its inputs and trust rules from
`shared/inputs-and-trust.md`, which `plugins.ts` puts in place of the
`<!-- yarvis-review:inputs-and-trust -->` line when it writes a run's copy;
`rereviewer` takes its own from `shared/rereview-inputs-and-trust.md`, in place
of `<!-- yarvis-review:rereview-inputs-and-trust -->`. Claude Code has no include for agent files,
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
