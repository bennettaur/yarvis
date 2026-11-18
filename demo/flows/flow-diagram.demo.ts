import { spawnSync } from "node:child_process";
import { OWNER, REPO } from "../fakeGithub/data";
import { expect, test } from "../fixture";

const graph = {
  nodes: [
    {
      id: "CheckoutPage",
      kind: "component",
      file: "src/checkout/CheckoutPage.tsx",
      line: 18,
      changed: false,
    },
    {
      id: "PaymentStep",
      kind: "component",
      file: "src/checkout/PaymentStep.tsx",
      line: 12,
      changed: true,
    },
    {
      id: "SavedCards",
      kind: "component",
      file: "src/checkout/PaymentStep.tsx",
      line: 64,
      changed: true,
    },
    {
      id: "usePaymentIntent",
      kind: "hook",
      file: "src/checkout/usePaymentIntent.ts",
      line: 9,
      changed: true,
    },
    {
      id: "CardForm",
      kind: "component",
      file: "src/checkout/CardForm.tsx",
      line: 5,
      changed: false,
    },
    { id: "createIntent", kind: "function", file: "src/api/payments.ts", line: 31, changed: false },
  ],
  edges: [
    { from: "CheckoutPage", to: "PaymentStep", kind: "renders" },
    { from: "PaymentStep", to: "SavedCards", kind: "renders" },
    { from: "PaymentStep", to: "CardForm", kind: "lazy-loads" },
    { from: "PaymentStep", to: "usePaymentIntent", kind: "calls" },
    { from: "usePaymentIntent", to: "createIntent", kind: "calls" },
  ],
};

const REF_KEY = `gh:${OWNER}/${REPO}/477`;

function runSql(sql: string, vars: Record<string, string> = {}): void {
  const args = [process.env.DEMO_DATABASE_URL ?? "", "-v", "ON_ERROR_STOP=1", "-q"];
  for (const [name, value] of Object.entries(vars)) args.push("-v", `${name}=${value}`);
  const result = spawnSync("psql", args, { input: sql, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
}

// The demo has no guide agent, so the guide and its graph go straight into the table.
test.beforeEach(() => {
  runSql(
    `INSERT INTO pr_guides (ref_key, provider, title, head_sha, steps, graph)
    VALUES (:'ref_key', 'github', 'Payment step: show saved cards first',
      '4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39',
      '[{"path":"src/checkout/PaymentStep.tsx","startLine":1,"endLine":40,"explanation":"Start here."}]'::jsonb,
      :'graph'::jsonb)`,
    { ref_key: REF_KEY, graph: JSON.stringify(graph) },
  );
});

// Other flows open the same pull request, and a guide adds its own panel there.
test.afterEach(() => {
  runSql("DELETE FROM pr_guides WHERE ref_key = :'ref_key'", { ref_key: REF_KEY });
});

test("flow diagram", async ({ demo, page }) => {
  await demo.openTab("PRs");
  await demo.click(page.getByRole("button", { name: /^Needs review/ }));
  await demo.click(page.getByText("Payment step: show saved cards first"));
  const toggle = page.getByRole("button", { name: /Flow diagram/ });
  await expect(toggle).toBeVisible();
  await toggle.scrollIntoViewIfNeeded();
  await demo.shot("diagram closed");

  await demo.click(toggle);
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
  // Let Excalidraw finish zooming to fit.
  await page.waitForTimeout(1500);
  await demo.shot("diagram open");
});
