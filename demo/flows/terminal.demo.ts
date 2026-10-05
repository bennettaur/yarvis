import { expect, test } from "../fixture";

test("terminal", async ({ demo, page }) => {
  await demo.openTab("Terminal");
  const terminal = page.locator(".xterm").filter({ visible: true }).first();
  await demo.click(terminal);

  await page.keyboard.type("git status", { delay: 60 });
  await demo.press("Enter");
  await expect(page.getByText("modified:   src/checkout/PaymentStep.tsx")).toBeVisible();

  await page.keyboard.type("bun test", { delay: 60 });
  await demo.press("Enter");
  await expect(page.getByText("Ran 5 tests across 2 files.")).toBeVisible();
  await demo.shot("git status and tests");
});
