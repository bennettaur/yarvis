import { describe, expect, it } from "bun:test";
import { type ComponentProps, createElement } from "react";
import { renderToHtml } from "../test/render";
import ChatMessages from "./ChatMessages";

const EMPTY_HINT = "Start a conversation.";

function render(props: Partial<ComponentProps<typeof ChatMessages>>) {
  return renderToHtml(
    createElement(ChatMessages, {
      messages: [],
      streaming: "",
      busy: false,
      emptyHint: EMPTY_HINT,
      ...props,
    }),
  );
}

describe("ChatMessages", () => {
  it("renders assistant markdown as formatted HTML", async () => {
    const html = await render({
      messages: [{ role: "assistant", content: "## Plan\n\n- **first** step\n- `bun test`\n" }],
    });
    expect(html).toContain(">Plan</h2>");
    expect(html).toContain("<li");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
  });

  it("renders GitHub-flavored tables from the assistant", async () => {
    const html = await render({
      messages: [{ role: "assistant", content: "| a | b |\n| --- | --- |\n| 1 | 2 |" }],
    });
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("renders fenced code from the assistant as a code block", async () => {
    const html = await render({
      messages: [{ role: "assistant", content: '```ts\nconst x = "hi";\n```' }],
    });
    expect(html).toContain("<pre");
    expect(html).toContain('const x = "hi";');
    expect(html).not.toContain("```");
  });

  it("escapes raw HTML in an assistant reply instead of rendering it", async () => {
    const html = await render({
      messages: [{ role: "assistant", content: 'hi <img src=x onerror="alert(1)"> there' }],
    });
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("does not fetch images an assistant reply asks for", async () => {
    const html = await render({
      messages: [{ role: "assistant", content: "![leak](https://elsewhere.example/p.png?q=1)" }],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
    // Shown as a placeholder whose title carries the destination.
    expect(html).toContain("leak");
    expect(html).toContain('title="https://elsewhere.example/p.png?q=1"');
  });

  it("keeps user text verbatim while formatting the assistant's reply", async () => {
    const html = await render({
      messages: [
        { role: "user", content: "rename __init__ to *setup*" },
        { role: "assistant", content: "renamed *setup*" },
      ],
    });
    expect(html).toContain("rename __init__ to *setup*");
    expect(html).toContain("<em>setup</em>");
  });

  it("formats the in-flight streaming reply as markdown, replacing hint and indicator", async () => {
    const html = await render({ streaming: "**partly** there", busy: true });
    expect(html).toContain("<strong");
    expect(html).not.toContain(EMPTY_HINT);
    expect(html).not.toContain("Thinking…");
  });

  it("shows the waiting indicator while a reply has yet to produce text", async () => {
    const html = await render({
      messages: [{ role: "user", content: "hello" }],
      busy: true,
    });
    expect(html).toContain("Thinking…");
  });

  it("labels Telegram-relayed messages by sender", async () => {
    const html = await render({
      messages: [
        {
          role: "user",
          content: "check *this*",
          metadata: { source: "telegram" as const, telegramUsername: "mike" },
        },
      ],
    });
    expect(html).toContain("Telegram · @mike");
    expect(html).toContain("check *this*");
  });

  it("shows the empty hint until there is something to render", async () => {
    const html = await render({});
    expect(html).toContain(EMPTY_HINT);
  });
});
