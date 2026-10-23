import { expect, test } from "../fixture";

test("issues", async ({ demo, page }) => {
  await demo.openTab("Issues");
  await expect(page.getByText("Apple Pay sheet opens twice on iOS 18")).toBeVisible();
  await demo.shot("assigned issues");

  await demo.click(page.getByRole("button", { name: "+ New issue" }));
  await demo.type(
    page.getByPlaceholder("Short title"),
    "Saved card logos are blurry on retina screens",
  );
  await demo.type(
    page.getByPlaceholder("Optional description (Markdown)"),
    "The Visa and Mastercard marks on the saved-cards list use the 1x sprite.",
  );
  await demo.shot("new issue");
  await demo.click(page.getByRole("button", { name: "Create", exact: true }));
  // Creating opens the new issue.
  await expect(page.getByText("use the 1x sprite")).toBeVisible();
  await demo.shot("issue created");

  await demo.click(page.getByRole("button", { name: "← Back" }));
  await demo.click(page.getByText("Apple Pay sheet opens twice on iOS 18"));
  await expect(page.getByText("Reproduced on an iPhone 15")).toBeVisible();
  const reply = "Looks like the double mount Priya found. Taking this one.";
  await demo.type(page.getByRole("textbox", { name: "Add a comment" }), reply);
  await demo.click(page.getByRole("button", { name: "Comment", exact: true }));
  await expect(page.getByText(reply)).toBeVisible();
  await demo.shot("comment posted");

  // Start work opens a workspace on the issue, with Claude Code running in it.
  await demo.click(page.getByRole("button", { name: "Start work", exact: true }));
  await expect(page.getByText("Welcome to Claude Code!")).toBeVisible({ timeout: 20_000 });
  await demo.shot("workspace for the issue");
});
