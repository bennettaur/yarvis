/**
 * A local stand-in for github.com/acme/checkout-web, so a workspace can use the
 * repo with no network. The sidecar clones a repo only when its primary clone
 * is missing, so one is put where it looks (`primaryClonePath` in
 * `sidecar/src/workspaces/service.ts`), with `origin` pointing at a bare repo
 * on disk. Every later fetch and worktree add then runs locally.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER, REPO } from "./fakeGithub/data";
import { DEMO_TMP, WORKSPACES_ROOT } from "./stack";

const REMOTES = join(DEMO_TMP, "remotes");

/**
 * Git with no user or system config, so the developer's signing setup, hooks
 * and identity don't apply, and commits come out the same on every machine.
 */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Alex Rivera",
      GIT_AUTHOR_EMAIL: "alex@example.com",
      GIT_COMMITTER_NAME: "Alex Rivera",
      GIT_COMMITTER_EMAIL: "alex@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.error}`);
  }
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** `main` before the payment-step work: the card form renders first. */
const MAIN_FILES: Record<string, string> = {
  "README.md": "# checkout-web\n\nThe checkout flow for the Acme store.\n",
  "package.json": `${JSON.stringify({ name: "checkout-web", private: true, scripts: { test: "bun test" } }, null, 2)}\n`,
  "src/checkout/CardForm.tsx": [
    "export default function CardForm({ cart }: { cart: Cart }) {",
    '  return <form aria-label="New card">{/* card fields */}</form>;',
    "}",
    "",
  ].join("\n"),
  "src/checkout/PaymentStep.tsx": [
    'import { useSavedCards } from "./useSavedCards";',
    'import { CardForm } from "./CardForm";',
    "",
    "export function PaymentStep({ cart }: { cart: Cart }) {",
    "  const cards = useSavedCards();",
    "  return (",
    "    <section>",
    "      <CardForm cart={cart} />",
    "      <SavedCards cards={cards} />",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/checkout/usePaymentIntent.ts": [
    'import { useQuery } from "@tanstack/react-query";',
    'import { createPaymentIntent } from "./api";',
    "",
    "export function usePaymentIntent(cart: Cart) {",
    "  return useQuery({",
    '    queryKey: ["intent", cart.id],',
    "    queryFn: () => createPaymentIntent(cart),",
    "  });",
    "}",
    "",
  ].join("\n"),
};

/**
 * The uncommitted work in the seeded workspace, matching what the scripted
 * shell's `git status` reports.
 */
const WORK_IN_PROGRESS: Record<string, string> = {
  "src/checkout/PaymentStep.tsx": [
    'import { lazy, Suspense } from "react";',
    'import { useSavedCards } from "./useSavedCards";',
    "",
    'const CardForm = lazy(() => import("./CardForm"));',
    "",
    "export function PaymentStep({ cart }: { cart: Cart }) {",
    "  const cards = useSavedCards();",
    "  return (",
    "    <section>",
    "      <SavedCards cards={cards} />",
    "      <Suspense fallback={<CardFormSkeleton />}>",
    "        <CardForm cart={cart} />",
    "      </Suspense>",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/checkout/usePaymentIntent.ts": [
    'import { useQuery } from "@tanstack/react-query";',
    'import { cachedPaymentIntent } from "./api";',
    "",
    "export function usePaymentIntent(cart: Cart) {",
    "  return useQuery({",
    '    queryKey: ["intent", cart.id],',
    "    queryFn: () => cachedPaymentIntent(cart),",
    "    retry: 3,",
    "  });",
    "}",
    "",
  ].join("\n"),
  "tests/checkout/payment-step.test.ts": [
    'import { render, screen } from "@testing-library/react";',
    'import { PaymentStep } from "../../src/checkout/PaymentStep";',
    "",
    'it("renders saved cards first", async () => {',
    "  render(<PaymentStep cart={cartWithSavedCards} />);",
    '  const [first] = await screen.findAllByRole("radio");',
    '  expect(first).toHaveAccessibleName("Visa ending 4242");',
    "});",
    "",
  ].join("\n"),
};

/**
 * Creates the bare "origin" and the primary clone the sidecar will find. Run
 * after the stack has wiped the workspaces root, and before any workspace
 * using the repo is provisioned.
 */
export function createCheckoutRepo(): void {
  rmSync(REMOTES, { recursive: true, force: true });
  const source = join(REMOTES, `${REPO}-source`);
  const bare = join(REMOTES, `${REPO}.git`);
  mkdirSync(source, { recursive: true });
  git(source, "init", "--quiet", "--initial-branch=main");
  writeFiles(source, MAIN_FILES);
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "Split the cart summary out of the payment form");
  git(REMOTES, "clone", "--quiet", "--bare", source, bare);
  // The path `primaryClonePath` builds. Anywhere else, provisioning clones from github.com.
  const primaryClone = join(".repos", `${OWNER}-${REPO}`.toLowerCase());
  git(WORKSPACES_ROOT, "clone", "--quiet", bare, primaryClone);
}

/** Leaves the payment-step changes uncommitted in a worktree of the repo. */
export function writeWorkInProgress(worktreePath: string): void {
  writeFiles(worktreePath, WORK_IN_PROGRESS);
}
