import { expect, test } from "../fixture";

test("agent channel", async ({ demo, page }) => {
  await demo.openTab("Settings");
  await demo.click(page.getByRole("button", { name: "Repositories" }));

  const checkbox = page.getByRole("checkbox", { name: /Message sessions over a channel/ });
  await checkbox.scrollIntoViewIfNeeded();
  await expect(checkbox).not.toBeChecked();
  await expect(
    page.getByText("Turning it off stops channel messages from the next one."),
  ).toBeVisible();
  await demo.shot("agent channel off");

  await demo.click(checkbox);
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  await demo.shot("agent channel on");
});
