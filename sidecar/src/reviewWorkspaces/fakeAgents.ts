/**
 * Stands in for the verification agents in tests: each process of a section's
 * run is told which agent it runs as (`--agent`), so a fake `claude` answers
 * with that agent's part of a whole report. Test-only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultLine } from "../agentRuns/testSupport.ts";
import { REPORT_SECTIONS, SECTION_AGENTS } from "./verification.ts";

/** What a later reading group answers, so a report's findings appear once. */
const LATER_GROUP: Record<string, unknown> = {
  "risk-reviewer": { level: "low", clientImpact: "", mitigations: [], concerns: [] },
};
const PASS = { status: "pass", findings: [] };

/**
 * Writes, under `dir/answers`, each section's answer from `report` as its
 * agent would give it: the summary agent's `summary` and `mustRead`, every
 * other agent its own field. Group 1 (or the only process) answers that; a
 * later group of a grouped section answers a pass.
 */
export function writeAgentAnswers(dir: string, report: Record<string, unknown>): void {
  mkdirSync(join(dir, "answers"), { recursive: true });
  const write = (name: string, answer: unknown) =>
    writeFileSync(
      join(dir, "answers", name),
      `${JSON.stringify(resultLine({ structured_output: answer }))}\n`,
    );
  for (const section of REPORT_SECTIONS) {
    const answer =
      section === "summary"
        ? report.summary === undefined
          ? undefined
          : { summary: report.summary, mustRead: report.mustRead ?? [] }
        : report[section];
    if (answer === undefined) continue;
    const name = agentName(SECTION_AGENTS[section]);
    write(`${name}.jsonl`, answer);
    write(`${name}.later.jsonl`, LATER_GROUP[name] ?? PASS);
  }
}

function agentName(agent: string): string {
  return agent.replace(/^yarvis-review:/, "");
}

/**
 * Shell for a fake `claude` that prints the answer {@link writeAgentAnswers}
 * wrote for the agent named by `--agent`. It expects the prompt in `$input`.
 */
export function printAgentAnswer(dir: string): string {
  return `agent=""; prev=""
for a in "$@"; do [ "$prev" = "--agent" ] && agent="$a"; prev="$a"; done
name="\${agent#yarvis-review:}"
case "$input" in
  *"GROUP=1") cat "${dir}/answers/$name.jsonl" ;;
  *"GROUP="*) cat "${dir}/answers/$name.later.jsonl" ;;
  *) cat "${dir}/answers/$name.jsonl" ;;
esac`;
}
