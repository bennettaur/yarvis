# yarvis-review

A Claude Code plugin that Yarvis loads into the headless runs behind its PR
review workspaces (`claude -p --plugin-dir <dir>`).

This folder is the source. The sidecar embeds every file listed in
`sidecar/src/agentRuns/plugins.ts` into its binary and writes a fresh copy to a
private temp directory for each run, removed when the run ends.

The verification report has one run per section (summary, change map, claims,
risk, malicious intent, tests, complexity, performance, comments,
observability, quality, approach, and the flow diagram), so each can be re-run
on its own, and `sidecar/src/reviewWorkspaces/checklist.ts` puts the report
together from each section's newest answer. A run starts from
`sidecar/src/reviewWorkspaces/verification.ts`, which writes the PR's context,
an `index.md` of every changed file and one numbered patch per file
(`patches/<path>.diff`, `reviewWorkspaces/patchFiles.ts`) to a directory the
run may read, marks bulk to skim, and splits the rest into reading groups no
bigger than one agent can hold. Each section's agent then runs as the main
thread of its own process (`--agent yarvis-review:<agent>`), once per reading
group for risk and the checks. The sidecar checks each answer, asks a failed
one again once, and puts the answers together in code
(`combineSectionAnswers`). Once the run answers it adds which changed files
no agent read (`reviewWorkspaces/coverage.ts`, from the run's Read calls).
For the malicious-intent check it also writes `tripwires.md`, what
`reviewWorkspaces/tripwires.ts`'s fixed rules found in the diff, and adds that
list to the check's answer itself, so the agent can't drop one.
Duplicate findings across sections are removed when `checklist.ts` puts the
report together, among results for the same head.

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
of `<!-- yarvis-review:rereview-inputs-and-trust -->`. Claude Code has no
include for agent files, so this is how each agent gets the same guardrail
from one source. Every agent here runs as a run's main thread, so its
`tools:` line lists `StructuredOutput`, the tool a run started with
`--json-schema` answers through.

The same agents also run on OpenCode, for a verification run on an OpenCode
harness. OpenCode can't load this plugin, so `pluginAgentPrompt` in
`plugins.ts` takes each agent's body without its frontmatter and
`agentRuns/opencode.ts` gives it to OpenCode as the agent's prompt, with the
answer's JSON schema added and the tools fixed at read, grep and glob. An
agent's body therefore can't rely on anything only its frontmatter or Claude
Code provides.

To add an agent, put its file here in Claude Code's plugin layout
(`agents/<name>.md`) and add it to the plugin's file list in `plugins.ts`. A
file that isn't listed there never reaches the run.

To try the plugin by hand against a checkout, use a copy `writePluginCopy`
wrote, since the agents here lack the shared section:

```bash
claude --plugin-dir <copy>/yarvis-review
```
