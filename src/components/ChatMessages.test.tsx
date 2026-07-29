import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";
import ChatMessages from "./ChatMessages";

const EMPTY_HINT = "Start a conversation.";

describe("ChatMessages", () => {
  it("renders assistant markdown as formatted HTML", async () => {
    const html = await renderToHtml(
      createElement(ChatMessages, {
        messages: [
          {
            role: "assistant",
            content: "## Plan\n\n- **first** step\n- `bun test`\n",
          },
        ],
        streaming: "",
        busy: false,
        emptyHint: EMPTY_HINT,
      }),
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<li");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
    expect(html).not.toContain("## Plan");
  });

  it("renders fenced code from the assistant as a code block", async () => {
    const html = await renderToHtml(
      createElement(ChatMessages, {
        messages: [{ role: "assistant", content: '```ts\nconst x = "hi";\n```' }],
        streaming: "",
        busy: false,
        emptyHint: EMPTY_HINT,
      }),
    );
    expect(html).toContain("<pre");
    expect(html).toContain('const x = "hi";');
    expect(html).not.toContain("```");
  });

  it("shows user text verbatim so markdown punctuation survives", async () => {
    const html = await renderToHtml(
      createElement(ChatMessages, {
        messages: [{ role: "user", content: "rename __init__ to *setup*" }],
        streaming: "",
        busy: false,
        emptyHint: EMPTY_HINT,
      }),
    );
    expect(html).toContain("rename __init__ to *setup*");
    expect(html).not.toContain("<em");
  });

  it("formats the in-flight streaming reply as markdown", async () => {
    const html = await renderToHtml(
      createElement(ChatMessages, {
        messages: [],
        streaming: "**partly** there",
        busy: true,
        emptyHint: EMPTY_HINT,
      }),
    );
    expect(html).toContain("<strong");
    expect(html).not.toContain(EMPTY_HINT);
    // The waiting indicator gives way to the reply as soon as text arrives.
    expect(html).not.toContain("Thinking…");
  });

  it("labels Telegram-relayed messages by sender and leaves them unparsed", async () => {
    const html = await renderToHtml(
      createElement(ChatMessages, {
        messages: [
          {
            role: "user",
            content: "check *this*",
            metadata: { source: "telegram" as const, telegramUsername: "mike" },
          },
        ],
        streaming: "",
        busy: false,
        emptyHint: EMPTY_HINT,
      }),
    );
    expect(html).toContain("Telegram · @mike");
    expect(html).toContain("check *this*");
  });

  it("shows the empty hint until there is something to render", async () => {
    const html = await renderToHtml(
      createElement(ChatMessages, {
        messages: [],
        streaming: "",
        busy: false,
        emptyHint: EMPTY_HINT,
      }),
    );
    expect(html).toContain(EMPTY_HINT);
  });
});
