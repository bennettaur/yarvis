import { expect, test } from "../fixture";

test("github", async ({ demo, page }) => {
  await demo.openTab("PRs");
  await expect(
    page.getByText("Load the payment step lazily behind the checkout flag"),
  ).toBeVisible();
  await demo.shot("my prs");

  await demo.click(page.getByRole("button", { name: /^Needs review/ }));
  const pr = page.getByText("Payment step: show saved cards first");
  await expect(pr).toBeVisible();
  await demo.shot("needs review");

  await demo.click(pr);
  await expect(page.getByText("Saved cards now load before the new-card form")).toBeVisible();
  await demo.shot("pr detail");

  await demo.openTab("Issues");
  await expect(page.getByText("Apple Pay sheet opens twice on iOS 18")).toBeVisible();
  await demo.shot("issues");
});
