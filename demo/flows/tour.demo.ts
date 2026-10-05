import { expect, test } from "../fixture";

test("tour", async ({ demo, page }) => {
  await demo.openTab("Tasks");
  await demo.shot("tasks");

  await demo.type(page.getByPlaceholder("Add a task..."), "Send the rollout plan to Priya");
  await demo.click(page.getByRole("button", { name: "Add", exact: true }));
  await expect(page.getByText("Send the rollout plan to Priya")).toBeVisible();
  await demo.shot("task added");

  await demo.openTab("Memory");
  await demo.shot("memory");

  await demo.openTab("Dashboard");
  await demo.shot("dashboard");

  await demo.fireAlarm({
    id: "demo-standup",
    label: "Checkout standup",
    fireAtMs: Date.now(),
    sound: false,
    meetLink: "https://meet.google.com/abc-defg-hij",
  });
  await demo.pause(1200);
  await demo.shot("alarm fired");
});
