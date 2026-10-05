import { expect, test } from "../fixture";

test("chat", async ({ demo, page }) => {
  await demo.openTab("Chat");
  const composer = page.getByPlaceholder("Message...");

  await demo.type(composer, "What's on my plate this week?");
  await demo.press("Enter");
  await expect(page.getByText("Priya's payment-step PR is your most urgent review")).toBeVisible();
  await demo.shot("week summary");

  await demo.type(composer, "Add a task to send the rollout plan to Priya on Friday");
  await demo.press("Enter");
  await expect(page.getByText("It's on your Tasks list now")).toBeVisible();
  await demo.shot("task created by chat");

  await demo.openTab("Tasks");
  // The Chat tab stays mounted while hidden, so its copy of the title is skipped.
  await expect(
    page.getByText("Send the rollout plan to Priya", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await demo.shot("task on the list");
});
