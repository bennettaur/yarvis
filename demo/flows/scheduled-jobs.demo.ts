import { expect, test } from "../fixture";
import { DEMO_SPECIALIST } from "../stack";

test("scheduled jobs", async ({ demo, page }) => {
  await demo.openTab("Jobs");
  await expect(page.getByText("No scheduled jobs yet.")).toBeVisible();

  await demo.click(page.getByRole("button", { name: "New job" }));
  await demo.type(page.getByPlaceholder("Morning sweep"), "Standup draft");
  await demo.click(page.getByRole("button", { name: "Weekday mornings" }));
  await expect(page.getByPlaceholder("0 9 * * 1-5")).toHaveValue("0 9 * * 1-5");
  await demo.type(
    page.getByPlaceholder("What this job is for"),
    "Have my standup ready before the 9:30 call",
  );
  await demo.type(
    page.getByPlaceholder("What the agent should do on every run"),
    "Draft my standup update from my tasks: what I did yesterday, what's on today, and anything blocking me.",
    { delay: 25 },
  );
  // Agent stays on Yarvis; the specialist runs on the fake model.
  const specialist = page.getByRole("combobox", { name: "Specialist" });
  await demo.hover(specialist);
  await specialist.selectOption(DEMO_SPECIALIST);
  await expect(specialist).toHaveValue(DEMO_SPECIALIST);
  await demo.shot("new job");

  await demo.click(page.getByRole("button", { name: "Create job" }));
  await expect(page.getByRole("button", { name: /^Standup draft/ })).toBeVisible();
  await expect(page.getByText("This job hasn't run yet.")).toBeVisible();
  await demo.shot("job scheduled");

  await demo.click(page.getByRole("button", { name: "Run now" }));
  await expect(page.getByText("Finished.")).toBeVisible({ timeout: 30_000 });
  // The newest run is the only one; its row opens to show what the agent wrote.
  const run = page.getByRole("button", { name: /^ok\b/ });
  await demo.click(run);
  const output = page.getByText("code complete is this week's goal");
  await expect(output).toBeVisible();
  // The output opens below the fold.
  await output.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await demo.shot("run output");
});
