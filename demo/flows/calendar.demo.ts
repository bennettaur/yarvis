import { expect, test } from "../fixture";

test("calendar", async ({ demo, page }) => {
  await demo.openTab("Calendar");
  await expect(page.getByText("Design review: payment step")).toBeVisible();
  await demo.shot("agenda");

  await demo.click(page.getByRole("button", { name: "Set alarm" }).first());
  await demo.shot("alarm set");

  await demo.click(page.getByRole("button", { name: "Week", exact: true }));
  await expect(page.getByText("1:1 with Priya")).toBeVisible();
  await demo.shot("week");
});
