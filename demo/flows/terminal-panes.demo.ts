import { expect, test } from "../fixture";

test("terminal panes", async ({ demo, page }) => {
  await demo.openTab("Terminal");
  const panes = page.locator("[data-pane-id]").filter({ visible: true });
  const terminalIn = (index: number) => panes.nth(index).locator(".xterm");

  await demo.click(terminalIn(0));
  await page.keyboard.type("git status", { delay: 60 });
  await demo.press("Enter");
  await expect(page.getByText("modified:   src/checkout/PaymentStep.tsx")).toBeVisible();
  await demo.shot("one pane");

  // Splits are keyboard-only. Cmd, not Ctrl, so the shell keeps Ctrl+D.
  await demo.press("Meta+d");
  await expect(panes).toHaveCount(2);
  await demo.click(terminalIn(1));
  await page.keyboard.type("bun test", { delay: 60 });
  await demo.press("Enter");
  await expect(page.getByText("Ran 5 tests across 2 files.")).toBeVisible();
  await demo.shot("split right");

  await demo.press("Meta+Shift+d");
  await expect(panes).toHaveCount(3);
  await demo.click(terminalIn(2));
  await page.keyboard.type("git log --oneline", { delay: 60 });
  await demo.press("Enter");
  await expect(page.getByText("Cache the payment intent across retries")).toBeVisible();
  await demo.shot("split below");

  await demo.click(page.getByRole("button", { name: "New tab" }));
  await expect(page.getByRole("button", { name: "Terminal 2", exact: true })).toBeVisible();
  await expect(panes).toHaveCount(1);
  await demo.click(terminalIn(0));
  await page.keyboard.type("claude", { delay: 60 });
  await demo.press("Enter");
  await expect(page.getByText("Welcome to Claude Code!")).toBeVisible();
  await demo.shot("claude in a new tab");

  // Back on the first tab, its three panes reattach with their output.
  // By title, since the nav rail's Terminal button has the same name.
  await demo.click(page.getByTitle("Terminal", { exact: true }));
  await expect(panes).toHaveCount(3);
  await expect(page.getByText("Ran 5 tests across 2 files.")).toBeVisible();
  await demo.shot("first tab again");
});
