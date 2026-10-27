import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import reviewManifest from "../../claude-plugins/yarvis-review/.claude-plugin/plugin.json";
import changeSummary from "../../claude-plugins/yarvis-review/agents/change-summary.md" with {
  type: "text",
};
import commentReviewer from "../../claude-plugins/yarvis-review/agents/comment-reviewer.md" with {
  type: "text",
};
import completenessReviewer from "../../claude-plugins/yarvis-review/agents/completeness-reviewer.md" with {
  type: "text",
};
import complexityReviewer from "../../claude-plugins/yarvis-review/agents/complexity-reviewer.md" with {
  type: "text",
};
import performanceReviewer from "../../claude-plugins/yarvis-review/agents/performance-reviewer.md" with {
  type: "text",
};
import rereviewer from "../../claude-plugins/yarvis-review/agents/rereviewer.md" with {
  type: "text",
};
import riskReviewer from "../../claude-plugins/yarvis-review/agents/risk-reviewer.md" with {
  type: "text",
};
import testReviewer from "../../claude-plugins/yarvis-review/agents/test-reviewer.md" with {
  type: "text",
};
import reviewReadme from "../../claude-plugins/yarvis-review/README.md" with { type: "text" };
import inputsAndTrust from "../../claude-plugins/yarvis-review/shared/inputs-and-trust.md" with {
  type: "text",
};
import rereviewInputsAndTrust from "../../claude-plugins/yarvis-review/shared/rereview-inputs-and-trust.md" with {
  type: "text",
};
import verificationReport from "../../claude-plugins/yarvis-review/skills/verification-report/SKILL.md" with {
  type: "text",
};

/** Where a review agent's source takes the shared inputs-and-trust section. */
export const INPUTS_AND_TRUST_MARKER = "<!-- yarvis-review:inputs-and-trust -->";

/**
 * The same for the re-review agent, whose inputs are a since-review's rather
 * than the whole PR's.
 */
export const REREVIEW_INPUTS_AND_TRUST_MARKER = "<!-- yarvis-review:rereview-inputs-and-trust -->";

/**
 * A review agent with the shared section spliced in. Claude Code agent files
 * have no include, and the system prompt a run appends never reaches its
 * subagents, so each agent carries the trust rules itself; keeping them in
 * one file is what stops seven copies drifting apart. Throws at load when an
 * agent lacks the marker, so a missing guardrail can't ship.
 */
export function withInputsAndTrust(
  agent: string,
  shared: string = inputsAndTrust,
  marker: string = INPUTS_AND_TRUST_MARKER,
): string {
  const parts = agent.split(marker);
  if (parts.length !== 2) {
    throw new Error(`a review agent must contain ${marker} exactly once`);
  }
  return parts.join(shared.trim());
}

/**
 * The Claude Code plugins Yarvis ships to its headless runs.
 *
 * Each plugin's source is a folder under `sidecar/claude-plugins/`, laid out the
 * way Claude Code expects, so it can be reviewed in git and loaded by hand with
 * `claude --plugin-dir`. Its files are imported as text, which embeds them in the
 * compiled sidecar — a release build has no source tree to point Claude Code
 * at — and `writePluginCopy` writes them out for a run.
 *
 * A file reaches a run only by being listed here: adding an agent or a skill is
 * its file in the plugin folder plus an import and an entry in that plugin's map.
 * Manifests are imported as JSON rather than text because TypeScript types a
 * `.json` import as its parsed shape whatever the import attribute says.
 */
const PLUGINS = {
  "yarvis-review": {
    ".claude-plugin/plugin.json": `${JSON.stringify(reviewManifest, null, 2)}\n`,
    "README.md": reviewReadme,
    "agents/change-summary.md": withInputsAndTrust(changeSummary),
    "agents/risk-reviewer.md": withInputsAndTrust(riskReviewer),
    "agents/completeness-reviewer.md": withInputsAndTrust(completenessReviewer),
    "agents/test-reviewer.md": withInputsAndTrust(testReviewer),
    "agents/complexity-reviewer.md": withInputsAndTrust(complexityReviewer),
    "agents/performance-reviewer.md": withInputsAndTrust(performanceReviewer),
    "agents/comment-reviewer.md": withInputsAndTrust(commentReviewer),
    "agents/rereviewer.md": withInputsAndTrust(
      rereviewer,
      rereviewInputsAndTrust,
      REREVIEW_INPUTS_AND_TRUST_MARKER,
    ),
    "skills/verification-report/SKILL.md": verificationReport,
  },
} satisfies Record<string, Record<string, string>>;

export type PluginName = keyof typeof PLUGINS;

export interface PluginCopy {
  /** The directory to hand to `--plugin-dir`. */
  dir: string;
  remove: () => void;
}

/** Refuses a listed path that would land outside the plugin's folder. */
function checkedRelativePath(path: string): string {
  const normalized = normalize(path);
  if (isAbsolute(normalized) || normalized.split(sep).includes("..")) {
    throw new Error(`plugin file path escapes its folder: ${path}`);
  }
  return normalized;
}

/**
 * Writes a fresh copy of a plugin for one run, in a new private temp directory,
 * and returns it with a way to remove it once the run is over.
 *
 * Fresh per run rather than one long-lived copy: a plugin is agent prompts and
 * tool grants, and a shared copy under the home directory is something anything
 * running as the user could edit between runs — including an earlier run that
 * was pointed at a hostile checkout. A copy nobody else has seen can't have been
 * tampered with, and there is no "is the copy current?" question to get wrong.
 */
export function writePluginCopy(
  name: PluginName,
  files: Record<string, string> = PLUGINS[name],
): PluginCopy {
  // mkdtemp creates the directory 0700, so other users can't read or swap it.
  const root = mkdtempSync(join(tmpdir(), "yarvis-plugin-"));
  const remove = () => rmSync(root, { recursive: true, force: true });
  try {
    const dir = join(root, name);
    for (const [path, content] of Object.entries(files)) {
      const destination = join(dir, checkedRelativePath(path));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    return { dir, remove };
  } catch (e) {
    remove();
    throw e;
  }
}
