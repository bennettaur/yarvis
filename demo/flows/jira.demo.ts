import { expect, test } from "../fixture";

test("jira", async ({ demo, page }) => {
  await demo.openTab("Issues");
  await demo.click(page.getByRole("button", { name: "JIRA", exact: true }));
  await expect(page.getByText("Show the card brand logo on saved cards")).toBeVisible();
  await demo.shot("assigned tickets");

  await demo.click(page.getByText("Show the card brand logo on saved cards"));
  await expect(page.getByText("Design has the logo set ready")).toBeVisible();
  const reply = "Logos are in, using the SVG set. Moving this to review.";
  await demo.type(page.getByPlaceholder("Add a comment…"), reply);
  await demo.click(page.getByRole("button", { name: "Comment", exact: true }));
  await expect(page.getByText(reply)).toBeVisible();

  // The status select has no label, so it's found by its options: the moves
  // away from the current status. Once In Review, it offers In Progress.
  const statusSelect = page.getByRole("combobox").filter({ hasText: "→ In Review" });
  await demo.hover(statusSelect);
  await statusSelect.selectOption({ label: "→ In Review" });
  await expect(page.getByRole("combobox").filter({ hasText: "→ In Progress" })).toBeVisible();
  await demo.shot("commented and moved to review");

  await demo.click(page.getByRole("button", { name: "← Back" }));
  await demo.click(page.getByText("Retry a declined card against the same payment intent"));
  await demo.click(page.getByRole("button", { name: "Start work", exact: true }));
  await expect(page.getByRole("heading", { name: "Start work on PAY-139" })).toBeVisible();
  await demo.click(page.getByRole("checkbox", { name: /checkout-web/ }));
  const moveTo = page.getByRole("combobox", { name: "Move ticket to" });
  await demo.hover(moveTo);
  await moveTo.selectOption({ label: "In Progress" });
  await expect(moveTo.locator("option:checked")).toHaveText("In Progress");
  await demo.shot("start work on a ticket");

  await demo.click(page.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByText("Welcome to Claude Code!")).toBeVisible({ timeout: 20_000 });
  await demo.shot("workspace for the ticket");
});
