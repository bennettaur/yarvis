import { expect, test } from "../fixture";

test("calendar", async ({ demo, page }) => {
  await demo.openTab("Calendar");
  // The agenda lists only what's still ahead, and tomorrow's 1:1 always is,
  // whatever time of day the flow runs.
  await expect(page.getByText("1:1 with Priya")).toBeVisible();
  await demo.shot("agenda");

  await demo.click(page.getByRole("button", { name: "Set alarm" }).first());
  await demo.shot("alarm set");

  await demo.click(page.getByRole("button", { name: "Week", exact: true }));
  await expect(page.getByText("1:1 with Priya")).toBeVisible();
  await demo.shot("week");
});
