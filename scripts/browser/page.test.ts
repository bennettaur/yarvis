import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BLOCKED_LABEL_SOURCE, BLOCKED_PATH_SOURCE } from "../../extension/site.js";

/**
 * The in-page half of the extension (extension/page.js and the Slack adapter)
 * against happy-dom. happy-dom does no layout, so every element is given a size
 * and the point a click lands on is chosen per test.
 */

interface Page {
  readPage(options: { maxChars: number }): Record<string, unknown>;
  listElements(options: Record<string, unknown>): {
    error?: string;
    adapter?: string;
    elements: Array<Record<string, unknown>>;
    skipped?: number;
  };
  inspect(options: Record<string, unknown>): {
    error?: string;
    count: number;
    matches: Array<Record<string, unknown>>;
  };
  click(options: Record<string, unknown>): {
    ok?: boolean;
    error?: string;
    clicked?: { tag: string; label: string };
  };
}

const screens = { blockedSource: BLOCKED_LABEL_SOURCE, blockedPathSource: BLOCKED_PATH_SOURCE };
const page = () => (globalThis as unknown as { __yarvis: Page }).__yarvis;
const happy = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

const originalRect = Element.prototype.getBoundingClientRect;
const originalFromPoint = document.elementFromPoint;

beforeAll(async () => {
  await import("../../extension/adapters/kit.js");
  await import("../../extension/adapters/slack.js");
  await import("../../extension/adapters/gmail.js");
  await import("../../extension/adapters/calendar.js");
  await import("../../extension/page.js");
});

beforeEach(() => {
  happy().setURL("https://app.slack.com/client/T111/C999");
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 }) as DOMRect;
  document.elementFromPoint = () => null;
  document.title = "general (Channel) - Acme - Slack";
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  document.elementFromPoint = originalFromPoint;
  document.body.innerHTML = "";
  happy().setURL("about:blank");
});

/** Records which events reach an element, to tell a click from a hover. */
function listen(el: Element): string[] {
  const seen: string[] = [];
  for (const type of ["pointerdown", "mousedown", "click", "mouseover"]) {
    el.addEventListener(type, () => seen.push(type));
  }
  return seen;
}

describe("click", () => {
  it("clicks the element under the middle of a row, where the handler is", () => {
    document.body.innerHTML = `
      <div role="treeitem" id="row"><a id="link" href="/client/T111/C222"><span id="name">agentic-intake</span></a></div>`;
    const name = document.getElementById("name") as HTMLElement;
    document.elementFromPoint = () => name;
    const seen = listen(document.getElementById("link") as Element);

    const out = page().click({ selector: "#row", ...screens });

    expect(out.error).toBeUndefined();
    expect(out.clicked).toEqual({ tag: "span", label: "agentic-intake" });
    expect(seen).toEqual(["mouseover", "pointerdown", "mousedown", "click"]);
  });

  it("refuses an unlabelled icon button that would take the click", () => {
    document.body.innerHTML = `<div role="treeitem" id="row">general<button id="trash"></button></div>`;
    const trash = document.getElementById("trash") as HTMLElement;
    document.elementFromPoint = () => trash;
    const seen = listen(trash);

    expect(page().click({ selector: "#row", ...screens }).error).toContain("without a label");
    expect(seen).toEqual([]);
  });

  it("refuses a labelled button nested in a same-site link", () => {
    document.body.innerHTML = `
      <a id="row" href="/client/T111/C222">general<button id="leave" aria-label="Leave channel"></button></a>`;
    document.elementFromPoint = () => document.getElementById("leave");

    expect(page().click({ selector: "#row", ...screens }).error).toContain("changes or sends");
  });

  it("refuses a same-site link to a state-changing address", () => {
    document.body.innerHTML = `<a id="out" href="/logout">Your profile</a>`;
    expect(page().click({ selector: "#out", ...screens }).error).toContain("changes something");
  });

  it("refuses a link to another site", () => {
    document.body.innerHTML = `<a id="away" href="https://evil.example/">Docs</a>`;
    expect(page().click({ selector: "#away", ...screens }).error).toContain("leaves this site");
  });

  it("refuses a container too big to click safely", () => {
    document.body.innerHTML = `<div id="pane">${"message text ".repeat(40)}</div>`;
    expect(page().click({ selector: "#pane", ...screens }).error).toContain("container");
  });

  it("reports a bad selector and one that matches nothing", () => {
    expect(page().click({ selector: "a >>> b", ...screens }).error).toContain("isn't valid CSS");
    expect(page().click({ selector: "#missing", ...screens }).error).toContain(
      "Nothing on the page",
    );
  });

  it("refuses form controls, and a label that would toggle one", () => {
    document.body.innerHTML = `
      <label id="lbl" for="opt">Email me updates</label><input id="opt" type="checkbox" />
      <input id="img" type="image" alt="Go" />
      <div role="switch" id="sw" aria-label="Notifications"></div>`;
    for (const selector of ["#lbl", "#opt", "#img", "#sw"]) {
      expect(page().click({ selector, ...screens }).error).toContain("form control");
    }
  });

  it("refuses a span whose click would bubble to a form control", () => {
    document.body.innerHTML = `<label id="lbl"><input type="checkbox" /><span id="text">Remember me</span></label>`;
    expect(page().click({ selector: "#text", ...screens }).error).toContain("form control");
  });

  it("refuses something the user can't see", () => {
    document.body.innerHTML = `<button id="hidden">Threads</button>`;
    Element.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }) as DOMRect;
    expect(page().click({ selector: "#hidden", ...screens }).error).toContain("isn't visible");
  });

  it("refuses a download link", () => {
    document.body.innerHTML = `<a id="dl" href="/files/report.pdf" download>Report</a>`;
    expect(page().click({ selector: "#dl", ...screens }).error).toContain("downloads a file");
  });

  it("refuses a selector that matches on an attribute value it may not probe", () => {
    document.head.innerHTML = `<meta name="csrf-token" content="abc123" />`;
    for (const selector of ['meta[content^="a"]', '[data-token*="x"]', 'a[href*="token="]']) {
      expect(page().inspect({ selector, limit: 5, ...screens }).error).toContain(
        "attribute values only",
      );
    }
    expect(
      page().inspect({ selector: '[data-qa="row"]', limit: 5, ...screens }).error,
    ).toBeUndefined();
    document.head.innerHTML = "";
  });

  it("screens what a click activates above the chosen element", () => {
    document.body.innerHTML = `
      <a href="/logout"><span id="in-link" role="button">Profile</span></a>
      <label for="chk"><div id="in-label" role="button">Notify</div></label><input id="chk" type="checkbox" />
      <form><button><span id="in-submit" role="button">Go</span></button></form>
      <form><button type="reset" id="reset">Start over</button></form>`;
    expect(page().click({ selector: "#in-link", ...screens }).error).toContain("changes something");
    expect(page().click({ selector: "#in-label", ...screens }).error).toContain("form control");
    expect(page().click({ selector: "#in-submit", ...screens }).error).toContain(
      "submits or resets",
    );
    expect(page().click({ selector: "#reset", ...screens }).error).toContain("submits or resets");
  });

  it("refuses a click inside a toggle widget", () => {
    document.body.innerHTML = `<div role="switch"><span id="in-switch" role="button">Notifications</span></div>`;
    expect(page().click({ selector: "#in-switch", ...screens }).error).toContain("form control");
  });

  it("refuses an editable area", () => {
    document.body.innerHTML = `<div id="composer" contenteditable="plaintext-only" aria-label="Message">hi</div>`;
    const composer = document.getElementById("composer") as HTMLElement;
    Object.defineProperty(composer, "isContentEditable", { value: true });
    expect(page().click({ selector: "#composer", ...screens }).error).toContain("form control");
  });

  it("refuses every way of spelling a probe on a hidden attribute", () => {
    for (const selector of [
      "[*|content^=a]",
      "[|content^=a]",
      "[\\63 ontent^=a]",
      "[content/**/^=a]",
      'html:has(meta[*|content^="a"])',
      "[content ^= a]",
      "[CONTENT^=a]",
      "[content^=a",
    ]) {
      expect(page().inspect({ selector, limit: 5, ...screens }).error).toBeDefined();
    }
  });

  it("allows plain attribute tests, including brackets inside a quoted value", () => {
    document.body.innerHTML = `<button aria-label="a]b" data-qa="x">Threads</button>`;
    for (const selector of [
      '[aria-label="a]b"]',
      "[data-qa=x]",
      "[href]",
      "button[role]",
      '[role="button" i]',
    ]) {
      expect(page().inspect({ selector, limit: 5, ...screens }).error).toBeUndefined();
    }
  });

  it("only hovers in hover mode", () => {
    document.body.innerHTML = `<div role="button" id="menu">More options</div>`;
    const seen = listen(document.getElementById("menu") as Element);

    expect(page().click({ selector: "#menu", mode: "hover", ...screens }).ok).toBe(true);
    expect(seen).toEqual(["mouseover"]);
  });

  it("sends the click to the chosen element itself in direct mode", () => {
    document.body.innerHTML = `<div role="treeitem" id="row"><span id="inner">random</span></div>`;
    document.elementFromPoint = () => document.getElementById("inner");

    expect(page().click({ selector: "#row", mode: "direct", ...screens }).clicked?.tag).toBe("div");
  });

  it("clicks by a ref from a listing, and reads an older listing's ref as gone", () => {
    document.body.innerHTML = `<button id="b">Threads</button>`;
    const first = page().listElements({ maxElements: 50, ...screens });
    const old = first.elements.find((el) => el.label === "Threads")?.ref;
    const second = page().listElements({ maxElements: 50, ...screens });
    const ref = second.elements.find((el) => el.label === "Threads")?.ref;

    expect(ref).not.toBe(old);
    expect(page().click({ ref, ...screens }).ok).toBe(true);
    expect(page().click({ ref: old, ...screens }).error).toContain("gone");
  });
});

describe("listElements roles", () => {
  it("keeps a page-controlled role to a plain word", () => {
    document.body.innerHTML = `<div role='button" [ref=9]&#10;- link "Inbox" [ref=3]'>Threads</div>`;
    const out = page().listElements({ maxElements: 50, selector: "div", ...screens });
    expect(out.elements[0]?.kind).toBe("button");
  });
});

describe("listElements", () => {
  it("leaves out controls that send or change things and says how many", () => {
    document.body.innerHTML = `<button>Threads</button><button>Send</button><button>Delete message</button>`;
    const out = page().listElements({ maxElements: 50, ...screens });
    expect(out.elements.map((el) => el.label)).toEqual(["Threads"]);
    expect(out.skipped).toBe(2);
  });

  it("filters by text and lists what a custom selector matches", () => {
    document.body.innerHTML = `
      <div data-qa="item" role="treeitem">agentic-intake</div>
      <div data-qa="item" role="treeitem">random</div>`;
    const byText = page().listElements({ maxElements: 50, text: "INTAKE", ...screens });
    expect(byText.elements.map((el) => el.label)).toEqual(["agentic-intake"]);

    const bySelector = page().listElements({
      maxElements: 50,
      selector: '[data-qa="item"]',
      ...screens,
    });
    expect(bySelector.elements).toHaveLength(2);
  });

  it("tags Slack conversations with their id and an address that opens them", () => {
    document.body.innerHTML = `
      <div role="treeitem"><div data-qa-channel-sidebar-channel-id="C0ABC1234">agentic-intake</div></div>`;
    const out = page().listElements({ maxElements: 50, ...screens });
    expect(out.adapter).toBe("slack");
    expect(out.elements[0]).toMatchObject({
      label: "agentic-intake",
      channelId: "C0ABC1234",
      openUrl: "https://app.slack.com/client/T111/C0ABC1234",
    });
  });
});

describe("inspect", () => {
  it("never shows scripts, and hides the text of what isn't rendered", () => {
    document.body.innerHTML = `
      <script>window.boot = { token: "xoxc-secret" }</script>
      <div id="shown" data-qa="row">visible text</div>`;
    const scripts = page().inspect({ selector: "script", limit: 5, ...screens });
    expect(scripts.count).toBe(0);

    Element.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }) as DOMRect;
    const hidden = page().inspect({ selector: "#shown", limit: 5, ...screens });
    expect(hidden.matches[0]?.text).toBe("");
  });

  it("shows ids and test hooks but not arbitrary data attributes", () => {
    document.body.innerHTML = `<div id="x" data-qa="row" data-channel-id="C1" data-signed-url="https://cdn/x?sig=abc">row</div>`;
    const out = page().inspect({ selector: "#x", limit: 5, ...screens });
    expect(out.matches[0]?.attributes).toEqual({
      id: "x",
      "data-qa": "row",
      "data-channel-id": "C1",
    });
  });

  it("reports the same refusal a click would get", () => {
    document.body.innerHTML = `<div role="treeitem" id="row">general<button id="trash"></button></div>`;
    const inspected = page().inspect({ selector: "#trash", limit: 5, ...screens });
    const clicked = page().click({ selector: "#trash", ...screens });
    expect(inspected.matches[0]?.refused).toBe(clicked.error);
  });

  it("shows structure without values that carry data, and why a click would be refused", () => {
    document.body.innerHTML = `
      <div role="treeitem" data-qa="row" class="c-row">
        <input name="csrf" value="secret-token" type="hidden" />
        <a href="/logout?session=abc">Sign out</a>
      </div>`;
    const out = page().inspect({ selector: "a, input", limit: 10, ...screens });

    expect(out.count).toBe(2);
    const [input, link] = out.matches as [Record<string, unknown>, Record<string, unknown>];
    expect(JSON.stringify(input)).not.toContain("secret-token");
    expect((link.attributes as Record<string, string>).href).toBe("/logout");
    expect(link.refused).toContain("changes something");
  });
});

describe("Slack readPage", () => {
  it("returns the loaded messages as a transcript, carrying the sender over", () => {
    document.body.innerHTML = `
      <div data-qa="message_container">
        <span data-qa="message_sender_name">Christine</span>
        <a class="c-timestamp" aria-label="Today at 12:40:24 PM"></a>
        <div data-qa="message-text">Can you look at the intake flow?</div>
        <span data-qa="reply_bar_count">3 replies</span>
      </div>
      <div data-qa="message_container">
        <a class="c-timestamp" aria-label="Today at 12:40:29 PM"></a>
        <div data-qa="message-text">It's blocking the pilot.</div>
      </div>`;
    const out = page().readPage({ maxChars: 10_000 });

    expect(out.adapter).toBe("slack");
    expect(out.text).toContain("Conversation: general (Channel)");
    expect(out.text).toContain(
      "[Today at 12:40:24 PM] Christine: Can you look at the intake flow? (3 replies)",
    );
    expect(out.text).toContain("[Today at 12:40:29 PM] Christine: It's blocking the pilot.");
  });

  it("keeps the newest messages when they don't all fit", () => {
    document.body.innerHTML = Array.from(
      { length: 50 },
      (_, i) => `
      <div data-qa="message_container">
        <span data-qa="message_sender_name">Max</span>
        <div data-qa="message-text">message number ${i} ${"x".repeat(40)}</div>
      </div>`,
    ).join("");
    const out = page().readPage({ maxChars: 800 });

    expect(out.truncated).toBe(true);
    expect(out.text).toContain("message number 49");
    expect(out.text).not.toContain("message number 0 ");
    expect((out.text as string).length).toBeLessThanOrEqual(900);
  });

  it("leaves out an open thread's messages", () => {
    document.body.innerHTML = `
      <div class="p-workspace__primary_view">
        <div data-qa="message_container">
          <span data-qa="message_sender_name">Christine</span>
          <div data-qa="message-text">In the channel</div>
        </div>
      </div>
      <div class="p-flexpane">
        <div data-qa="message_container"><div data-qa="message-text">In the thread</div></div>
      </div>`;
    const out = page().readPage({ maxChars: 10_000 });
    expect(out.text).toContain("In the channel");
    expect(out.text).not.toContain("In the thread");
  });

  it("builds an openUrl on an Enterprise Grid org too", () => {
    happy().setURL("https://app.slack.com/client/E0ORG1/C999");
    document.body.innerHTML = `
      <div role="treeitem"><div data-qa-channel-sidebar-channel-id="C0ABC1234">agentic-intake</div></div>`;
    const out = page().listElements({ maxElements: 50, ...screens });
    expect(out.elements[0]?.openUrl).toBe("https://app.slack.com/client/E0ORG1/C0ABC1234");
  });

  it("falls back to the page text and says so when it finds no messages", () => {
    document.body.innerHTML = `<main>Search results for "pilot"</main>`;
    const out = page().readPage({ maxChars: 10_000 });

    expect(out.adapter).toBeUndefined();
    expect(out.text).toContain("Search results");
    expect(out.adapterNote).toContain("slack reader found nothing");
  });

  it("isn't used off Slack", () => {
    happy().setURL("https://example.com/");
    document.body.innerHTML = `<div data-qa="message_container"><div data-qa="message-text">hi</div></div>`;
    const out = page().readPage({ maxChars: 10_000 });
    expect(out.adapter).toBeUndefined();
    expect(out.adapterNote).toBeUndefined();
  });
});

describe("Gmail readPage", () => {
  beforeEach(() => {
    happy().setURL("https://mail.google.com/mail/u/0/#inbox");
    document.title = "Inbox (2) - you@example.com - Mail";
  });

  it("lists conversations with unread marks and ids, newest first", () => {
    document.body.innerHTML = `
      <div role="main"><table><tbody>
        <tr class="zA zE">
          <td class="yX"><span class="yP" name="Max Jedrzejewski">Max</span></td>
          <td><span class="bog"><span data-legacy-thread-id="18c4f0a1b2">Forecast app V1</span></span>
              <span class="y2"> - Can we ship Friday?</span></td>
          <td class="xW"><span title="Fri, Oct 2, 2026, 4:10 PM">Oct 2</span></td>
        </tr>
        <tr class="zA">
          <td class="yX"><span class="zF" name="Rob Klomps">Rob</span></td>
          <td><span class="bog"><span data-legacy-thread-id="18c4e99999">Accepted: Standup</span></span></td>
          <td class="xW"><span title="Thu, Oct 1, 2026, 9:00 AM">Oct 1</span></td>
        </tr>
      </tbody></table></div>`;
    const out = page().readPage({ maxChars: 10_000 });

    expect(out.adapter).toBe("gmail");
    expect(out.text).toContain("Mailbox: Inbox (2)");
    expect(out.text).toContain("https://mail.google.com/mail/u/0/#all/<id>");
    expect(out.text).toContain(
      "● Fri, Oct 2, 2026, 4:10 PM · Max Jedrzejewski — Forecast app V1 — Can we ship Friday? [id 18c4f0a1b2]",
    );
    expect(out.text).toContain(
      "Thu, Oct 1, 2026, 9:00 AM · Rob Klomps — Accepted: Standup [id 18c4e99999]",
    );
    // The title carries the account's address; the adapter's version doesn't.
    expect(out.title).toBe("Inbox (2)");
    expect(JSON.stringify(out)).not.toContain("you@example.com");
  });

  it("reads an open conversation, keeping the latest messages when they don't fit", () => {
    document.body.innerHTML = `
      <div role="main">
        <h2 class="hP">Forecast app V1</h2>
        ${Array.from(
          { length: 30 },
          (_, i) => `
          <div class="adn">
            <span class="gD" name="Max" email="max@example.com">Max</span>
            <span class="g3" title="Oct ${i + 1}, 2026">Oct ${i + 1}</span>
            <div class="a3s">reply number ${i} ${"x".repeat(60)}</div>
          </div>`,
        ).join("")}
        <div class="adn"><span class="gD" name="Rob">Rob</span></div>
      </div>`;
    const out = page().readPage({ maxChars: 1_000 });

    expect(out.text).toContain("Conversation: Forecast app V1");
    expect(out.text).toContain("Max <max@example.com>:");
    expect(out.text).toContain("Rob:\n(collapsed; open it to read)");
    expect(out.text).toContain("reply number 29");
    expect(out.text).not.toContain("reply number 0 ");
    expect(out.truncated).toBe(true);
  });
});

describe("Gmail stale views", () => {
  beforeEach(() => {
    happy().setURL("https://mail.google.com/mail/u/0/#inbox");
    document.title = "Inbox - you@example.com - Mail";
  });

  it("reads the mailbox when a thread left earlier is still in the page, hidden", () => {
    document.body.innerHTML = `
      <div role="main">
        <h2 class="hP" id="stale">Old thread</h2>
        <table><tbody><tr class="zA"><td class="yX"><span class="yP" name="Rob">Rob</span></td>
          <td><span class="bog">Fresh mail</span></td><td class="xW"><span>9:00</span></td></tr></tbody></table>
      </div>`;
    const stale = document.getElementById("stale") as HTMLElement;
    stale.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    const out = page().readPage({ maxChars: 10_000 });
    expect(out.text).toContain("Mailbox: Inbox");
    expect(out.text).toContain("Fresh mail");
    expect(out.text).not.toContain("Old thread");
  });

  it("falls back when there is neither a mailbox nor a conversation", () => {
    document.body.innerHTML = `<div role="main">Settings</div>`;
    expect(page().readPage({ maxChars: 10_000 }).adapterNote).toContain(
      "gmail reader found nothing",
    );
  });
});

describe("adapter kit fit", () => {
  const fit = () =>
    (
      globalThis as unknown as {
        __yarvisAdapterKit: {
          fit(
            lines: string[],
            budget: number,
            o: { keep: string },
          ): { kept: string[]; omitted: number };
        };
      }
    ).__yarvisAdapterKit.fit;

  it("keeps lines from the end that matters, in their order", () => {
    expect(fit()(["a1", "b2", "c3"], 6, { keep: "last" })).toEqual({
      kept: ["b2", "c3"],
      omitted: 1,
    });
    expect(fit()(["a1", "b2", "c3"], 6, { keep: "first" })).toEqual({
      kept: ["a1", "b2"],
      omitted: 1,
    });
  });

  it("cuts the one line that matters rather than keeping nothing", () => {
    const { kept, omitted } = fit()(["old", "x".repeat(500)], 100, { keep: "last" });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toEndWith("… (cut)");
    expect((kept[0] as string).length).toBeLessThanOrEqual(100);
    expect(omitted).toBe(1);
  });
});

describe("Calendar readPage", () => {
  beforeEach(() => {
    happy().setURL("https://calendar.google.com/calendar/u/0/r/week");
    document.title = "Google Calendar - Week of October 4, 2026";
  });

  it("lists each event once, from its screen-reader description", () => {
    document.body.innerHTML = `
      <div role="button" data-eventid="a1"><div class="XuJrye">10am to 11am, Standup, Accepted, October 5, 2026</div>Standup</div>
      <div role="button" data-eventid="b2" aria-label="All day, Offsite, October 6, 2026"></div>
      <div role="button" data-eventid="b2" aria-label="All day, Offsite, October 6, 2026"></div>`;
    const out = page().readPage({ maxChars: 10_000 });

    expect(out.adapter).toBe("calendar");
    expect(out.text).toBe(
      "Calendar: Week of October 4, 2026\nEvents in view, in page order:\n- 10am to 11am, Standup, Accepted, October 5, 2026\n- All day, Offsite, October 6, 2026",
    );
  });

  it("falls back when there are no events in view", () => {
    document.body.innerHTML = `<main>Nothing scheduled</main>`;
    const out = page().readPage({ maxChars: 10_000 });
    expect(out.adapterNote).toContain("calendar reader found nothing");
  });
});
