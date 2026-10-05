import { describe, expect, it } from "bun:test";
import { FakeTerminals } from "./fakeShell";

const decoder = new TextDecoder();

function terminals() {
  const chunks: { id: string; offset: number; bytes: number[] }[] = [];
  const fake = new FakeTerminals((id, chunk) => chunks.push({ id, ...chunk }));
  /** Everything a session has shown, as the panel would assemble it. */
  const screen = (id: string) => decoder.decode(new Uint8Array(fake.attach(id).scrollback));
  return { fake, chunks, screen };
}

/** Waits for queued output to play. Canned commands here have no delays. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("FakeTerminals", () => {
  it("opens a new session showing a prompt", () => {
    const { screen } = terminals();
    expect(screen("tab")).toContain("~/dev/checkout-web");
  });

  it("echoes keys and answers a known command", async () => {
    const { fake, screen } = terminals();
    fake.attach("tab");
    fake.write("tab", "ls\r");
    await settle();
    expect(screen("tab")).toContain("ls\r\n");
    expect(screen("tab")).toContain("package.json");
  });

  it("rubs out a character on backspace", async () => {
    const { fake, screen } = terminals();
    fake.attach("tab");
    fake.write("tab", "lx\x7fs\r");
    await settle();
    expect(screen("tab")).toContain("\b \b");
    expect(screen("tab")).toContain("package.json");
  });

  it("says when a command doesn't exist", async () => {
    const { fake, screen } = terminals();
    fake.attach("tab");
    fake.write("tab", "make coffee\r");
    await settle();
    expect(screen("tab")).toContain("zsh: command not found: make");
  });

  it("emits each chunk at the offset where the previous one ended", async () => {
    const { fake, chunks } = terminals();
    const { endOffset } = fake.attach("tab");
    fake.write("tab", "ls\r");
    await settle();
    let expected = endOffset;
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(expected);
      expected += chunk.bytes.length;
    }
    expect(fake.attach("tab").endOffset).toBe(expected);
  });

  it("forgets a killed session", () => {
    const { fake } = terminals();
    fake.attach("tab");
    fake.kill("tab");
    expect(fake.exists("tab")).toBe(false);
  });

  it("starts an agent session that exists before anything attaches", () => {
    const { fake, screen } = terminals();
    fake.startAgent("ws-claude:1");
    expect(fake.exists("ws-claude:1")).toBe(true);
    expect(screen("ws-claude:1")).toContain("claude --permission-mode auto");
  });
});
