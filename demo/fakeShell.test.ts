import { describe, expect, it } from "bun:test";
import { FakeTerminals } from "./fakeShell";

const decoder = new TextDecoder();

function setUpTerminals() {
  const chunks: { id: string; offset: number; bytes: number[] }[] = [];
  // No waiting between chunks, so scripted delays don't slow the tests.
  const fake = new FakeTerminals(
    (id, chunk) => chunks.push({ id, ...chunk }),
    async () => {},
  );
  /** Everything a session has shown, as the panel would assemble it. */
  const screen = (id: string) => decoder.decode(new Uint8Array(fake.attach(id).scrollback));
  const emitted = (id: string) =>
    chunks
      .filter((c) => c.id === id)
      .map((c) => decoder.decode(new Uint8Array(c.bytes)))
      .join("");
  return { fake, chunks, screen, emitted };
}

/** Lets queued output play. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("FakeTerminals", () => {
  it("opens a new session empty, then shows a prompt", async () => {
    const { fake, screen } = setUpTerminals();
    // An empty first snapshot is how the panel knows the session is new.
    expect(fake.attach("tab").scrollback).toEqual([]);
    await settle();
    expect(screen("tab")).toContain("~/dev/checkout-web");
  });

  it("echoes keys and answers a known command", async () => {
    const { fake, screen } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "ls\r");
    await settle();
    expect(screen("tab")).toContain("ls\r\n");
    expect(screen("tab")).toContain("package.json");
  });

  it("rubs out a character on backspace", async () => {
    const { fake, screen } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "lx\x7fs\r");
    await settle();
    expect(screen("tab")).toContain("\b \b");
    expect(screen("tab")).toContain("package.json");
  });

  it("writes nothing for backspace on an empty line", async () => {
    const { fake, chunks } = setUpTerminals();
    fake.attach("tab");
    await settle();
    const before = chunks.length;
    fake.write("tab", "\x7f");
    await settle();
    expect(chunks.length).toBe(before);
  });

  it("discards the typed line on Ctrl+C", async () => {
    const { fake, screen } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "ls");
    fake.write("tab", "\x03");
    fake.write("tab", "\r");
    await settle();
    expect(screen("tab")).toContain("^C");
    expect(screen("tab")).not.toContain("package.json");
  });

  it("ignores arrow keys", async () => {
    const { fake, chunks } = setUpTerminals();
    fake.attach("tab");
    await settle();
    const before = chunks.length;
    fake.write("tab", "\x1b[A");
    await settle();
    expect(chunks.length).toBe(before);
  });

  it("clears the screen and redraws the prompt", async () => {
    const { fake, emitted } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "clear\r");
    await settle();
    expect(emitted("tab")).toContain("\x1b[2J\x1b[H");
  });

  it("says when a command doesn't exist", async () => {
    const { fake, screen } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "make coffee\r");
    await settle();
    expect(screen("tab")).toContain("zsh: command not found: make");
  });

  it("emits each chunk at the offset where the previous one ended", async () => {
    const { fake, chunks } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "ls\r");
    await settle();
    expect(chunks.length).toBeGreaterThan(0);
    let expected = 0;
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(expected);
      expected += chunk.bytes.length;
    }
    expect(fake.attach("tab").endOffset).toBe(expected);
  });

  it("drops a killed session's pending output, even when its id is reused", async () => {
    const { fake, emitted, screen } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "bun test\r");
    fake.kill("tab");
    expect(fake.exists("tab")).toBe(false);
    fake.attach("tab");
    await settle();
    expect(emitted("tab")).not.toContain("5 pass");
    expect(screen("tab")).not.toContain("bun test");
  });

  it("switches to a Claude Code session when you type claude", async () => {
    const { fake, screen, chunks } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "claude\r");
    await settle();
    expect(screen("tab")).toContain("Welcome to");

    const before = chunks.length;
    fake.write("tab", "\r");
    await settle();
    expect(chunks.length).toBe(before);

    fake.write("tab", "fix the retry\r");
    await settle();
    expect(screen("tab")).toContain("Done. The payment step");
  });

  it("takes a bracketed paste in Claude Code as one message", async () => {
    const { fake, screen } = setUpTerminals();
    fake.attach("tab");
    fake.write("tab", "claude\r");
    await settle();
    expect(screen("tab")).toContain("\x1b[?2004h");

    const comments = "Please address the following 2 review comments:\r\r1. a.ts:4\r   fix it";
    fake.write("tab", `\x1b[200~${comments}\x1b[201~`);
    await settle();
    expect(screen("tab")).toContain("[Pasted text #1 +3 lines]");
    expect(screen("tab")).not.toContain("I'll work through");

    fake.write("tab", "\r");
    await settle();
    expect(screen("tab")).toContain("Both comments are addressed.");
    expect(screen("tab")).not.toContain("Done. The payment step");
  });

  it("starts an agent session that exists before anything attaches", async () => {
    const { fake, screen } = setUpTerminals();
    fake.startAgent("ws1");
    expect(fake.exists("ws-claude:ws1")).toBe(true);
    await settle();
    expect(screen("ws-claude:ws1")).toContain("claude --permission-mode auto");
  });

  it("leaves a running agent session alone when asked to start it again", async () => {
    const { fake, emitted } = setUpTerminals();
    fake.startAgent("ws1");
    await settle();
    fake.startAgent("ws1");
    await settle();
    expect(emitted("ws-claude:ws1").split("Welcome to").length - 1).toBe(1);
  });
});
