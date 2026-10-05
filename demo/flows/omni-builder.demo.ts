import { expect, test } from "../fixture";

test("omni builder", async ({ demo, page }) => {
  await demo.openTab("Omni");
  await demo.type(
    page.getByPlaceholder("Describe a layout..."),
    "Build me a focus board for the checkout work",
  );
  await demo.click(page.getByRole("button", { name: "Build", exact: true }));
  await expect(page.getByRole("heading", { name: "Checkout redesign" })).toBeVisible();
  await expect(page.getByText("Prep demo for Thursday's review")).toBeVisible();
  await expect(
    page.getByText("Load the payment step lazily behind the checkout flag"),
  ).toBeVisible();
  await expect(page.getByText("Design review: payment step")).toBeVisible();
  await demo.shot("focus board");

  // The board's terminal widget runs a scripted shell.
  await demo.click(page.locator(".xterm").filter({ visible: true }).first());
  await page.keyboard.type("bun test", { delay: 60 });
  await demo.press("Enter");
  await expect(page.getByText("Ran 5 tests across 2 files.")).toBeVisible();
  await demo.shot("tests in the board terminal");
});
