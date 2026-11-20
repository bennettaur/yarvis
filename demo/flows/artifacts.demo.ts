import { expect, test } from "../fixture";

test("artifacts beside the chat", async ({ demo, page }) => {
  await demo.openTab("Chat");
  const composer = page.getByPlaceholder("Message...");

  await demo.type(composer, "Can you sketch the checkout architecture?");
  await demo.press("Enter");
  const diagramLink = page.getByRole("link", { name: "Checkout architecture" }).last();
  await expect(diagramLink).toBeVisible();
  await demo.shot("diagram link in the reply");

  await diagramLink.click();
  const pane = page.getByRole("region", { name: "Artifact: Checkout architecture" });
  await expect(pane.locator("canvas").first()).toBeVisible();
  await page.waitForTimeout(800);
  await demo.shot("diagram beside the chat");

  await demo.type(composer, "Add a queue for receipts after a payment clears");
  await demo.press("Enter");
  await expect(page.getByText("Added the receipts queue")).toBeVisible();
  await page.waitForTimeout(1200);
  await demo.shot("diagram redrawn with the queue");

  await demo.type(composer, "Write a launch plan for the payment step");
  await demo.press("Enter");
  const planLink = page.getByRole("link", { name: "Payment step launch plan" });
  await expect(planLink).toBeVisible();
  await planLink.click();
  await expect(
    page
      .getByRole("region", { name: "Artifact: Payment step launch plan" })
      .getByRole("heading", { name: "Rollout" }),
  ).toBeVisible();
  await demo.shot("markdown plan beside the chat");
});
