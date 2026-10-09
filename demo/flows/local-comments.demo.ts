import { expect, test } from "../fixture";

test("local comments", async ({ demo, page }) => {
  await demo.openTab("Workspaces");
  await demo.click(page.getByText("Payment step", { exact: true }));
  await expect(page.getByText("Welcome to Claude Code!")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("3 changed files")).toBeVisible();
  await demo.shot("changed files");

  /** Opens a changed file's diff and leaves a comment on the line holding `code`. */
  async function commentOnLine(path: string, code: string, body: string) {
    await demo.click(page.getByTitle(`Open diff for ${path}`));
    const line = demo.diffLine(code);
    await expect(line).toBeVisible();
    await demo.hover(line);
    await demo.click(line.getByRole("button", { name: "Comment on this line" }));
    await demo.type(page.getByPlaceholder("Note for yourself (or for Claude)…"), body);
    await demo.click(page.getByRole("button", { name: "Save comment" }));
    await expect(page.getByText(body)).toBeVisible();
    // Onto the diff's header, so no row is left showing its "+" button.
    await demo.hover(page.getByText(path, { exact: true }));
  }

  await commentOnLine(
    "src/checkout/PaymentStep.tsx",
    "const CardForm = lazy",
    "Customers with no saved cards now wait on this import. Prefetch it when the list comes back empty.",
  );
  await demo.shot("comment on the diff");

  await commentOnLine(
    "src/checkout/usePaymentIntent.ts",
    "retry: 3,",
    "Retry once, not three times, so a declined card doesn't hit the processor four times.",
  );

  await demo.click(page.getByRole("button", { name: /^Comments/ }));
  await expect(page.getByText("2 open")).toBeVisible();
  await demo.shot("comments list");

  await demo.click(page.getByRole("button", { name: "Copy for Claude" }));
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  // By title: the tab's accessible name also takes in its status dot.
  await demo.click(page.getByTitle("Claude", { exact: true }));
  const claudeTerminal = page.locator(".xterm").filter({ visible: true }).first();
  await demo.paste(claudeTerminal);
  await expect(page.getByText("[Pasted text #1")).toBeVisible();
  await demo.shot("pasted into claude");

  await demo.press("Enter");
  // A short phrase: the pane wraps the reply, and getByText can't match text
  // split across two terminal rows.
  await expect(page.getByText("Both comments are addressed.")).toBeVisible({ timeout: 20_000 });
  await demo.shot("claude addressed the comments");
});
