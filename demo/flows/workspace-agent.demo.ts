import { expect, test } from "../fixture";

test("workspace agent", async ({ demo, page }) => {
  await demo.openTab("Workspaces");
  await demo.click(page.getByText("Checkout redesign").first());
  await expect(page.getByText("Welcome to Claude Code!")).toBeVisible({ timeout: 15_000 });
  await demo.shot("agent session");

  await demo.click(page.locator(".xterm").first());
  await page.keyboard.type("Reuse the cached payment intent when a card is retried", { delay: 40 });
  await demo.press("Enter");
  await expect(page.getByText("all 5 checkout tests pass")).toBeVisible({ timeout: 20_000 });
  await demo.shot("agent finished");
});
