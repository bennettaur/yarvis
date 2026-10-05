import { expect, test } from "../fixture";

test("workspace agent", async ({ demo, page }) => {
  await demo.openTab("Workspaces");
  await demo.click(page.getByText("Payment step", { exact: true }));
  await expect(page.getByText("Welcome to Claude Code!")).toBeVisible({ timeout: 15_000 });
  await demo.shot("agent session");

  await demo.click(page.locator(".xterm").filter({ visible: true }).first());
  await page.keyboard.type("Reuse the cached payment intent when a card is retried", { delay: 40 });
  await demo.press("Enter");
  // Short phrases, so a narrower pane wrapping the line doesn't split them.
  await expect(page.getByText("Done. The payment step")).toBeVisible({ timeout: 20_000 });
  await demo.shot("agent finished");
});
