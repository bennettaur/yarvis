import { z } from "zod";

/**
 * Per-repo prompts for shipping a PR, one per step from CI to production.
 * They are stored in the repo's settings and nowhere else. An agent reads them
 * as the user's own instructions with nobody watching, so text from the repo
 * (a README, a CONTRIBUTING file) must never stand in for them.
 */
export const PLAYBOOK_KEYS = [
  "ci",
  "pickReviewer",
  "feedback",
  "review",
  "testStaging",
  "merge",
  "deploy",
  "monitorDeploy",
  "monitorProduction",
  "testProduction",
  "revert",
] as const;

export type PlaybookKey = (typeof PLAYBOOK_KEYS)[number];

export type RepoPlaybooks = Partial<Record<PlaybookKey, string>>;

/** What a create or update may carry: a prompt left empty or null is dropped. */
export type PlaybookInput = Partial<Record<PlaybookKey, string | null | undefined>>;

// Matches MAX_BODY_CHARS, the cap on a routine's body. Mirrored by PLAYBOOK_MAX_CHARS in src/lib/repos.ts.
export const MAX_PLAYBOOK_CHARS = 4000;

const playbookText = z.string().max(MAX_PLAYBOOK_CHARS).nullish();

export const repoPlaybooksSchema = z.object({
  ci: playbookText,
  pickReviewer: playbookText,
  feedback: playbookText,
  review: playbookText,
  testStaging: playbookText,
  merge: playbookText,
  deploy: playbookText,
  monitorDeploy: playbookText,
  monitorProduction: playbookText,
  testProduction: playbookText,
  revert: playbookText,
});

/** Trims each prompt and drops the empty ones, so a cleared text area stores nothing. */
export function normalizePlaybooks(input: PlaybookInput): RepoPlaybooks {
  const out: RepoPlaybooks = {};
  for (const key of PLAYBOOK_KEYS) {
    const text = input[key]?.trim();
    if (text) out[key] = text;
  }
  return out;
}
