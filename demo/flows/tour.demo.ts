import { expect, test } from "../fixture";

test("tour", async ({ demo, page }) => {
  await demo.openTab("Tasks");
  await expect(page.getByText("Prep demo for Thursday's review")).toBeVisible();
  await demo.shot("tasks");

  await demo.type(page.getByPlaceholder("Add a task..."), "Book the checkout retro");
  await demo.click(page.getByRole("button", { name: "Add", exact: true }));
  await expect(page.getByText("Book the checkout retro")).toBeVisible();
  await demo.shot("task added");

  await demo.openTab("Memory");
  await expect(page.getByText("Priya Shah leads the payments team")).toBeVisible();
  await demo.shot("memory");

  await demo.openTab("Dashboard");
  await expect(page.getByText("reachable")).toBeVisible();
  await demo.shot("dashboard");

  await demo.fireAlarm({
    id: "demo-standup",
    label: "Checkout standup",
    fireAtMs: Date.now(),
    sound: false,
    meetLink: "https://meet.google.com/abc-defg-hij",
  });
  await expect(page.getByRole("button", { name: "Acknowledge" })).toBeVisible();
  await demo.shot("alarm fired");
});
