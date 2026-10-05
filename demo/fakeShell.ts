/**
 * Fake terminal sessions for the Tauri mock. Each session behaves enough like
 * zsh in a PTY to record: it shows a prompt, echoes keys, and answers the
 * commands in `COMMANDS` with canned output. Typing `claude`, or starting a
 * workspace's agent session, switches to a scripted Claude Code session.
 *
 * Output follows the core's byte-offset protocol: every byte a session has
 * written is kept, `attach` returns all of it, and each later chunk is
 * emitted tagged with the offset it starts at.
 */

export type EmitOutput = (sessionId: string, chunk: { offset: number; bytes: number[] }) => void;

/** A piece of output and how long to wait before writing it. */
type Line = { text: string; delayMs?: number };

const ESC = "\x1b";
const reset = `${ESC}[0m`;
const dim = (s: string) => `${ESC}[2m${s}${reset}`;
const bold = (s: string) => `${ESC}[1m${s}${reset}`;
const green = (s: string) => `${ESC}[32m${s}${reset}`;
const red = (s: string) => `${ESC}[31m${s}${reset}`;
const cyan = (s: string) => `${ESC}[36m${s}${reset}`;
const magenta = (s: string) => `${ESC}[35m${s}${reset}`;
const orange = (s: string) => `${ESC}[38;5;209m${s}${reset}`;

const CWD = "~/dev/checkout-web";
const BRANCH = "feat/payment-step";
const PROMPT = `${cyan(CWD)} ${magenta(BRANCH)} ❯ `;
const RULE = dim("─".repeat(72));
const AGENT_PROMPT = `${RULE}\r\n> `;

/** Draws `rows` in a rounded box, padding each to the same visible width. */
function box(rows: string[], width = 52): Line[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes to measure text.
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const edge = (s: string) => orange(s);
  return [
    { text: `${edge(`╭${"─".repeat(width)}╮`)}\r\n` },
    ...rows.map((row) => ({
      text: `${edge("│")} ${row}${" ".repeat(Math.max(0, width - 1 - visible(row)))}${edge("│")}\r\n`,
    })),
    { text: `${edge(`╰${"─".repeat(width)}╯`)}\r\n\r\n` },
  ];
}

/** xterm treats `\n` as a bare line feed, so every line ends in `\r\n`. */
const lines = (...texts: string[]): Line[] => texts.map((text) => ({ text: `${text}\r\n` }));

const COMMANDS: Record<string, Line[]> = {
  ls: lines(
    `${cyan("src")}  ${cyan("tests")}  ${cyan("public")}  package.json  bun.lock  README.md  tsconfig.json`,
  ),
  "git status": lines(
    `On branch ${BRANCH}`,
    "Your branch is up to date with 'origin/feat/payment-step'.",
    "",
    "Changes not staged for commit:",
    `        ${red("modified:   src/checkout/PaymentStep.tsx")}`,
    `        ${red("modified:   src/checkout/usePaymentIntent.ts")}`,
    "",
    "Untracked files:",
    `        ${red("tests/checkout/payment-step.test.ts")}`,
  ),
  "git log --oneline": lines(
    `${orange("a41c9e2")} Load the payment step lazily behind the checkout flag`,
    `${orange("7d02b18")} Cache the payment intent across retries`,
    `${orange("19fe6c4")} Measure checkout load time in the perf dashboard`,
    `${orange("c3b8a71")} Split the cart summary out of the payment form`,
  ),
  "bun test": [
    { text: `${bold("bun test")} ${dim("v1.3.14")}\r\n\r\n` },
    { text: "tests/checkout/cart-totals.test.ts:\r\n", delayMs: 300 },
    { text: `${green("✓")} totals include tax ${dim("[2.11ms]")}\r\n`, delayMs: 150 },
    { text: `${green("✓")} totals round to the cent ${dim("[0.40ms]")}\r\n`, delayMs: 120 },
    { text: "\r\ntests/checkout/payment-step.test.ts:\r\n", delayMs: 250 },
    { text: `${green("✓")} renders saved cards first ${dim("[14.20ms]")}\r\n`, delayMs: 200 },
    { text: `${green("✓")} retries a declined card once ${dim("[8.03ms]")}\r\n`, delayMs: 180 },
    { text: `${green("✓")} loads in under a second ${dim("[612.51ms]")}\r\n`, delayMs: 650 },
    {
      text: `\r\n ${green("5 pass")}\r\n ${dim("0 fail")}\r\nRan 5 tests across 2 files. ${dim("[1.04s]")}\r\n`,
      delayMs: 200,
    },
  ],
};

const AGENT_WELCOME: Line[] = [
  { text: "", delayMs: 400 },
  ...box([`${orange("✻")} Welcome to ${bold("Claude Code")}!`, "", `  ${dim(`cwd: ${CWD}`)}`]),
];

/** What the agent does with any instruction. Written to read like a real session. */
const AGENT_REPLY: Line[] = [
  { text: `\r\n${RULE}\r\n\r\n`, delayMs: 100 },
  { text: `${orange("✻")} ${dim("Thinking…")}\r\n\r\n`, delayMs: 700 },
  { text: `${green("⏺")} I'll start with the payment step and its tests.\r\n\r\n`, delayMs: 900 },
  { text: `${green("⏺")} ${bold("Read")}(src/checkout/PaymentStep.tsx)\r\n`, delayMs: 600 },
  { text: `  ⎿  Read 184 lines\r\n\r\n`, delayMs: 300 },
  { text: `${green("⏺")} ${bold("Read")}(tests/checkout/payment-step.test.ts)\r\n`, delayMs: 500 },
  { text: `  ⎿  Read 96 lines\r\n\r\n`, delayMs: 300 },
  { text: `${green("⏺")} ${bold("Update")}(src/checkout/PaymentStep.tsx)\r\n`, delayMs: 900 },
  {
    text: `  ⎿  Updated src/checkout/PaymentStep.tsx with 6 additions and 2 removals\r\n`,
    delayMs: 300,
  },
  { text: `       ${red("- const intent = await createPaymentIntent(cart);")}\r\n`, delayMs: 80 },
  {
    text: `       ${green("+ const intent = await cachedPaymentIntent(cart, { retries: 1 });")}\r\n\r\n`,
    delayMs: 80,
  },
  { text: `${green("⏺")} ${bold("Bash")}(bun test tests/checkout)\r\n`, delayMs: 800 },
  { text: `  ⎿  ${green("5 pass")}, 0 fail\r\n\r\n`, delayMs: 1200 },
  {
    text: `${green("⏺")} Done. The payment step now reuses the cached intent on a retry, and all 5 checkout tests pass.\r\n\r\n`,
    delayMs: 700,
  },
];

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  mode: "shell" | "agent";
  bytes: number[];
  /** What's been typed since the last Enter. */
  input: string;
  /** Output still being played; keystrokes wait behind it. */
  queue: Promise<void>;
}

export class FakeTerminals {
  private sessions = new Map<string, Session>();

  constructor(private emitOutput: EmitOutput) {}

  exists(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Returns everything the session has written, starting a shell if it's new. */
  attach(id: string): { scrollback: number[]; endOffset: number } {
    let session = this.sessions.get(id);
    if (!session) {
      session = { mode: "shell", bytes: [], input: "", queue: Promise.resolve() };
      this.sessions.set(id, session);
      // Part of the snapshot rather than emitted, so the new pane shows it at once.
      session.bytes.push(...encoder.encode(PROMPT));
    }
    return { scrollback: [...session.bytes], endOffset: session.bytes.length };
  }

  /** Starts a workspace's agent session the way the core does: a shell that launches Claude Code. */
  startAgent(id: string): void {
    const session: Session = { mode: "agent", bytes: [], input: "", queue: Promise.resolve() };
    this.sessions.set(id, session);
    session.bytes.push(...encoder.encode(`${PROMPT}claude --permission-mode auto\r\n`));
    this.play(session, id, [...AGENT_WELCOME, { text: AGENT_PROMPT }]);
  }

  kill(id: string): void {
    this.sessions.delete(id);
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // Arrow keys and other escape sequences: there's no history to move through.
    if (data.startsWith(ESC)) return;
    for (const char of data) this.key(session, id, char);
  }

  private key(session: Session, id: string, char: string): void {
    if (char === "\r") {
      const command = session.input.trim();
      session.input = "";
      this.play(session, id, [
        { text: session.mode === "shell" ? "\r\n" : "" },
        ...this.run(session, command),
      ]);
    } else if (char === "\x7f") {
      if (session.input) {
        session.input = session.input.slice(0, -1);
        this.play(session, id, [{ text: "\b \b" }]);
      }
    } else if (char === "\x03") {
      session.input = "";
      this.play(session, id, [{ text: `^C\r\n${this.prompt(session)}` }]);
    } else if (char >= " ") {
      session.input += char;
      this.play(session, id, [{ text: char }]);
    }
  }

  private prompt(session: Session): string {
    return session.mode === "shell" ? PROMPT : AGENT_PROMPT;
  }

  /** The output for one submitted line, ending with the next prompt. */
  private run(session: Session, command: string): Line[] {
    if (session.mode === "agent") {
      return command ? [...AGENT_REPLY, { text: AGENT_PROMPT }] : [{ text: "" }];
    }
    if (command === "") return [{ text: PROMPT }];
    if (command === "clear") return [{ text: `${ESC}[2J${ESC}[H${PROMPT}` }];
    if (command === "claude" || command.startsWith("claude ")) {
      session.mode = "agent";
      return [...AGENT_WELCOME, { text: AGENT_PROMPT }];
    }
    const output = COMMANDS[command] ?? lines(`zsh: command not found: ${command.split(" ")[0]}`);
    return [...output, { text: PROMPT }];
  }

  /** Writes `output` after whatever is already playing, honouring each line's delay. */
  private play(session: Session, id: string, output: Line[]): void {
    session.queue = session.queue.then(async () => {
      for (const { text, delayMs } of output) {
        if (delayMs) await sleep(delayMs);
        if (!text || !this.sessions.has(id)) continue;
        const bytes = [...encoder.encode(text)];
        const offset = session.bytes.length;
        session.bytes.push(...bytes);
        this.emitOutput(id, { offset, bytes });
      }
    });
  }
}
