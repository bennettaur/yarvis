import { expect, test } from "../fixture";

test("omni chat", async ({ demo, page }) => {
  await demo.openTab("Tasks");
  await expect(page.getByText("Prep demo for Thursday's review")).toBeVisible();

  // What the global Control+Shift+Space shortcut sends.
  await demo.emit("omni-chat-summon");
  const composer = page.getByPlaceholder("Ask anything about what you're looking at…");
  await expect(composer).toBeVisible();
  await demo.shot("summoned");

  await demo.type(composer, "Summarize what I'm looking at");
  await demo.press("Enter");
  await expect(page.getByText("Want me to block out an hour")).toBeVisible();
  await demo.shot("answer about the screen");
});
