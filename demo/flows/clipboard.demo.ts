import { expect, sidecarHeaders, sidecarUrl, test } from "../fixture";

const STAGING_URL = "https://staging.checkout.example.com/cart?flag=checkout-v2";

const SAVED_ENTRIES = [
  { label: "Staging checkout", content: STAGING_URL, tags: ["checkout", "staging"] },
  {
    label: "Rollout note",
    content: "Ship the payment step to 10% of returning customers first.",
    tags: ["checkout"],
    pinned: true,
  },
  {
    label: "Standup update",
    content: "Yesterday: payment step behind the flag. Today: review #477. Blockers: none.",
    tags: ["standup"],
  },
];

test("clipboard", async ({ demo, page }) => {
  for (const entry of SAVED_ENTRIES) {
    const res = await page.request.post(sidecarUrl("/api/clipboard/entries"), {
      headers: sidecarHeaders(),
      data: entry,
    });
    expect(res.ok(), await res.text()).toBe(true);
  }

  await demo.openTab("Tasks");
  // What the global Control+Shift+V shortcut sends.
  await demo.emit("clipboard-summon");
  const search = page.getByRole("textbox", { name: "Search the clipboard" });
  await expect(page.getByText("Standup update")).toBeVisible();
  await demo.shot("saved entries");

  await search.pressSequentially("stag", { delay: 80 });
  await expect(page.getByText("Standup update")).toBeHidden();
  await expect(page.getByText(STAGING_URL)).toBeVisible();
  await demo.shot("search");
  await search.fill("");

  await demo.click(page.getByRole("button", { name: "New entry" }));
  await demo.type(page.getByRole("textbox", { name: "Entry label" }), "Rollout flag");
  await demo.type(page.getByRole("textbox", { name: "Entry content" }), "checkout-v2");
  await demo.type(page.getByRole("textbox", { name: "Entry tags" }), "checkout, flags");
  await demo.click(page.getByRole("button", { name: "Save entry" }));
  await expect(page.getByText("Rollout flag")).toBeVisible();
  await demo.shot("entry added");

  await demo.click(page.getByRole("button", { name: "History", exact: true }));
  await expect(page.getByText("https://github.com/acme/checkout-web/pull/477")).toBeVisible();
  await demo.shot("history");

  // Copying closes the palette; the copy lands at the front of History. It
  // reopens from the nav rail, the palette's other way in.
  await demo.click(page.getByRole("button", { name: "Saved", exact: true }));
  await demo.click(page.getByRole("button", { name: /^Staging checkout/ }));
  await expect(search).toBeHidden();
  await demo.click(page.getByRole("button", { name: "Clipboard", exact: true }));
  await demo.click(page.getByRole("button", { name: "History", exact: true }));
  await expect(page.getByText(STAGING_URL)).toBeVisible();
  await demo.shot("copied to history");
});
