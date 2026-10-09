import { expect, test } from "../fixture";

// The insight this flow posts is kept in the database, so the file is named to
// run after github.demo.ts, whose shot of PR #477 would otherwise show it.
test("pr review", async ({ demo, page }) => {
  await demo.openTab("PRs");
  await demo.click(page.getByRole("button", { name: /^Needs review/ }));
  await demo.click(page.getByText("Payment step: show saved cards first"));
  await expect(page.getByText("Saved cards now load before the new-card form")).toBeVisible();

  const lazyLine = demo.diffLine("const CardForm = lazy");
  await demo.hover(lazyLine);
  await demo.click(lazyLine.getByRole("button", { name: /^Ask about this line/ }));
  const question = page.getByPlaceholder("Ask about these lines");
  await expect(question).toBeVisible();
  // The composer and the answer card open below the line, past the bottom of the screen.
  const scrollToCentre = (el: Element) => el.scrollIntoView({ block: "center" });
  await question.evaluate(scrollToCentre);
  await demo.type(question, "Why is the card form lazy here?");
  await demo.shot("question on a line");

  await demo.press("Enter");
  const answer = page.getByText("One gap: a customer with");
  await expect(answer).toBeVisible({ timeout: 15_000 });
  await answer.evaluate(scrollToCentre);
  await demo.shot("answer");

  await demo.click(page.getByRole("button", { name: "Post", exact: true }));
  await expect(page.getByText("Posted to the PR")).toBeVisible();
  await demo.shot("answer posted");

  const retryLine = demo.diffLine("retry: 1,");
  await demo.hover(retryLine);
  await demo.click(retryLine.getByRole("button", { name: "Comment on this line" }));
  await demo.type(
    page.getByPlaceholder("Leave a comment…"),
    "Could the retry count come from the checkout config, so ops can tune it?",
  );
  await demo.click(page.getByRole("button", { name: "Comment", exact: true }));
  const comment = page.getByText("you · just now");
  await expect(comment).toBeVisible();
  await comment.evaluate(scrollToCentre);
  // Onto the file list, so no diff row is left showing its hover buttons.
  await demo.hover(page.getByText("usePaymentIntent.ts", { exact: true }));
  await demo.shot("comment posted");
});
