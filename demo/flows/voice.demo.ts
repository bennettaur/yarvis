import { expect, sidecarHeaders, sidecarUrl, test } from "../fixture";
import { FAKE_PROVIDER } from "../stack";

// Chromium's fake microphone, granted without a prompt. What it records is a
// beep; the fake model's speech-to-text hears VOICE_TRANSCRIPT in anything.
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

// Voice settings live in the sidecar's settings.json, which every later flow
// shares, so they're put back to "not set up" whatever happens here.
test.afterEach(async ({ request }) => {
  const res = await request.patch(sidecarUrl("/api/voice/config"), {
    headers: sidecarHeaders(),
    data: { sttProvider: "", sttModel: "", ttsProvider: "", ttsModel: "" },
  });
  expect(res.ok(), await res.text()).toBe(true);
});

test("voice", async ({ demo, page }) => {
  const res = await page.request.patch(sidecarUrl("/api/voice/config"), {
    headers: sidecarHeaders(),
    data: {
      sttProvider: FAKE_PROVIDER,
      sttModel: "whisper-demo",
      ttsProvider: FAKE_PROVIDER,
      ttsModel: "tts-demo",
      speakReplies: true,
      handsFree: false,
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  // Chat reads the voice settings when it mounts, which happened on load.
  await page.reload();
  await expect(page.getByRole("navigation").first()).toBeVisible({ timeout: 30_000 });

  await demo.openTab("Chat");
  await demo.click(page.getByRole("button", { name: "Start listening" }));
  await expect(page.getByText("Listening…")).toBeVisible();
  await demo.pause(1500);
  await demo.shot("listening");

  await demo.click(page.getByRole("button", { name: "Stop listening" }));
  await expect(
    page.getByText("Remind me to send Priya the load-time chart before Thursday's review"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("is on this week's list")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Speaking…")).toBeVisible();
  await demo.shot("spoken reply");

  await demo.openTab("Tasks");
  await expect(
    page.getByText("Send Priya the load-time chart", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await demo.shot("task from voice");
});
