import { expect, test } from "../fixture";

test("calendar", async ({ demo, page }) => {
  await demo.openTab("Calendar");
  // The agenda lists only what's still ahead, and tomorrow's 1:1 always is,
  // whatever time of day the flow runs.
  await expect(page.getByText("1:1 with Priya")).toBeVisible();
  await demo.shot("agenda");

  await demo.click(page.getByRole("button", { name: "Set alarm" }).first());
  await demo.shot("alarm set");

  // Today's meeting, not tomorrow's: on a Saturday tomorrow is next week. The
  // agenda may list it too, so first wait for the week's own navigation.
  await demo.click(page.getByRole("button", { name: "Week", exact: true }));
  await expect(page.getByRole("button", { name: "Next ›" })).toBeVisible();
  await expect(page.getByText("Design review: payment step")).toBeVisible();
  await demo.shot("week");
});
