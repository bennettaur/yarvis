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

import { agentSessionId, DEFAULT_AGENT_COMMAND } from "../src/components/workspaces/agentTab";

export type EmitOutput = (sessionId: string, chunk: { offset: number; bytes: number[] }) => void;

/** A piece of output and how long to wait before writing it. Empty text is a pure pause. */
type OutputChunk = { text: string; delayMs?: number };

/** What xterm sends for Backspace and Ctrl+C. */
const BACKSPACE = "\x7f";
const CTRL_C = "\x03";

const ESC = "\x1b";
/**
 * Claude Code turns on bracketed paste, so xterm wraps a paste in these
 * markers and its line breaks don't submit it line by line.
 */
const BRACKETED_PASTE_ON = `${ESC}[?2004h`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
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
function box(rows: string[], width = 52): OutputChunk[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes to measure text.
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return [
    { text: `${orange(`╭${"─".repeat(width)}╮`)}\r\n` },
    ...rows.map((row) => ({
      text: `${orange("│")} ${row}${" ".repeat(Math.max(0, width - 1 - visible(row)))}${orange("│")}\r\n`,
    })),
    { text: `${orange(`╰${"─".repeat(width)}╯`)}\r\n\r\n` },
  ];
}

/** xterm treats `\n` as a bare line feed, so every line ends in `\r\n`. */
const lines = (...texts: string[]): OutputChunk[] => texts.map((text) => ({ text: `${text}\r\n` }));

/**
 * Canned output, keyed by the command line exactly as typed (trimmed), so
 * `git status -s` doesn't match `git status`. Use `lines()` for output that
 * appears at once, or `{ text, delayMs }` chunks to pace it like a real run.
 */
const COMMANDS: Record<string, OutputChunk[]> = {
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

const AGENT_WELCOME: OutputChunk[] = [
  // The moment Claude Code takes to start.
  { text: "", delayMs: 400 },
  ...box([`${orange("✻")} Welcome to ${bold("Claude Code")}!`, "", `  ${dim(`cwd: ${CWD}`)}`]),
  { text: BRACKETED_PASTE_ON },
];

/** What the agent does with any instruction. Written to read like a real session. */
const AGENT_REPLY: OutputChunk[] = [
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

/**
 * What the agent does with review comments pasted from a workspace's Comments
 * view. Answers the two comments the local-comments flow leaves.
 */
const AGENT_REVIEW_REPLY: OutputChunk[] = [
  { text: `\r\n${RULE}\r\n\r\n`, delayMs: 100 },
  { text: `${orange("✻")} ${dim("Thinking…")}\r\n\r\n`, delayMs: 700 },
  { text: `${green("⏺")} I'll work through the 2 review comments.\r\n\r\n`, delayMs: 900 },
  { text: `${green("⏺")} ${bold("Update")}(src/checkout/PaymentStep.tsx)\r\n`, delayMs: 800 },
  { text: `  ⎿  Updated src/checkout/PaymentStep.tsx with 3 additions\r\n`, delayMs: 300 },
  { text: `       ${green("+ useEffect(() => {")}\r\n`, delayMs: 80 },
  {
    text: `       ${green('+   if (cards?.length === 0) void import("./CardForm");')}\r\n`,
    delayMs: 80,
  },
  { text: `       ${green("+ }, [cards]);")}\r\n\r\n`, delayMs: 80 },
  { text: `${green("⏺")} ${bold("Update")}(src/checkout/usePaymentIntent.ts)\r\n`, delayMs: 800 },
  {
    text: `  ⎿  Updated src/checkout/usePaymentIntent.ts with 1 addition and 1 removal\r\n`,
    delayMs: 300,
  },
  { text: `       ${red("-   retry: 3,")}\r\n`, delayMs: 80 },
  { text: `       ${green("+   retry: 1,")}\r\n\r\n`, delayMs: 80 },
  { text: `${green("⏺")} ${bold("Bash")}(bun test tests/checkout)\r\n`, delayMs: 800 },
  { text: `  ⎿  ${green("5 pass")}, 0 fail\r\n\r\n`, delayMs: 1200 },
  {
    text: `${green("⏺")} Both comments are addressed. The card form now prefetches when there are\r\n  no saved cards, and a declined card retries once.\r\n\r\n`,
    delayMs: 700,
  },
];

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Session {
  id: string;
  mode: "shell" | "agent";
  bytes: number[];
  /** What's been typed or pasted since the last Enter. */
  input: string;
  /** How many pastes this session has had, for numbering their placeholders. */
  pastes: number;
  /** Output still being played; keystrokes wait behind it. */
  queue: Promise<void>;
}

export class FakeTerminals {
  private sessions = new Map<string, Session>();

  /** `pause` waits out each chunk's delay; tests pass one that doesn't wait. */
  constructor(
    private emitOutput: EmitOutput,
    private pause: (ms: number) => Promise<void> = sleep,
  ) {}

  exists(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Returns everything the session has written, starting a shell if it's new. */
  attach(id: string): { scrollback: number[]; endOffset: number } {
    let session = this.sessions.get(id);
    if (!session) {
      // The prompt is emitted rather than put in the snapshot: an empty first
      // snapshot is how the panel tells a new session from a reattach.
      session = this.createSession(id, "shell");
      this.play(session, [{ text: PROMPT }]);
    }
    return { scrollback: [...session.bytes], endOffset: session.bytes.length };
  }

  /**
   * Starts a workspace's agent session the way the core does: a shell that
   * launches Claude Code. Like the core, it leaves an existing session alone.
   */
  startAgent(workspaceId: string): void {
    const id = agentSessionId(workspaceId);
    if (this.sessions.has(id)) return;
    const session = this.createSession(id, "agent");
    this.play(session, [
      { text: `${PROMPT}${DEFAULT_AGENT_COMMAND}\r\n` },
      ...AGENT_WELCOME,
      { text: AGENT_PROMPT },
    ]);
  }

  kill(id: string): void {
    this.sessions.delete(id);
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // xterm sends a whole paste in one write, markers and all.
    if (data.startsWith(PASTE_START)) {
      this.paste(session, data.slice(PASTE_START.length).replace(PASTE_END, ""));
      return;
    }
    // Arrow keys and other escape sequences are dropped: there's no history
    // or cursor movement to support.
    if (data.startsWith(ESC)) return;
    for (const char of data) this.key(session, char);
  }

  /** Adds a paste to the input and shows Claude Code's placeholder for it. */
  private paste(session: Session, text: string): void {
    session.input += text;
    session.pastes += 1;
    // xterm turns a paste's line breaks into \r, as if Enter were pressed.
    const extraLines = text.split("\r").length - 1;
    this.play(session, [{ text: dim(`[Pasted text #${session.pastes} +${extraLines} lines]`) }]);
  }

  private createSession(id: string, mode: Session["mode"]): Session {
    const session: Session = {
      id,
      mode,
      bytes: [],
      input: "",
      pastes: 0,
      queue: Promise.resolve(),
    };
    this.sessions.set(id, session);
    return session;
  }

  private key(session: Session, char: string): void {
    if (char === "\r") {
      const command = session.input.trim();
      session.input = "";
      this.play(session, this.submit(session, command));
    } else if (char === BACKSPACE) {
      if (session.input) {
        session.input = session.input.slice(0, -1);
        this.play(session, [{ text: "\b \b" }]);
      }
    } else if (char === CTRL_C) {
      session.input = "";
      this.play(session, [{ text: `^C\r\n${this.prompt(session)}` }]);
    } else if (char >= " ") {
      session.input += char;
      this.play(session, [{ text: char }]);
    }
  }

  private prompt(session: Session): string {
    return session.mode === "shell" ? PROMPT : AGENT_PROMPT;
  }

  /**
   * The output for one submitted line, ending with the next prompt. Typing
   * `claude` switches the session to agent mode; an empty line in agent mode
   * prints nothing.
   */
  private submit(session: Session, command: string): OutputChunk[] {
    if (session.mode === "agent") {
      if (!command) return [];
      // "Copy for Claude" text opens "Please address the following N review
      // comments". Both replies open with their own line break.
      const reply = /review comments?\b/i.test(command) ? AGENT_REVIEW_REPLY : AGENT_REPLY;
      return [...reply, { text: AGENT_PROMPT }];
    }
    const newline = { text: "\r\n" };
    if (command === "") return [newline, { text: PROMPT }];
    if (command === "clear") return [newline, { text: `${ESC}[2J${ESC}[H${PROMPT}` }];
    if (command === "claude" || command.startsWith("claude ")) {
      session.mode = "agent";
      return [newline, ...AGENT_WELCOME, { text: AGENT_PROMPT }];
    }
    const output = COMMANDS[command] ?? lines(`zsh: command not found: ${command.split(" ")[0]}`);
    return [newline, ...output, { text: PROMPT }];
  }

  /** Writes `output` after whatever is already playing, honouring each chunk's delay. */
  private play(session: Session, output: OutputChunk[]): void {
    session.queue = session.queue.then(async () => {
      for (const { text, delayMs } of output) {
        if (delayMs) await this.pause(delayMs);
        // A killed session stops, even if a new one has since taken its id.
        if (this.sessions.get(session.id) !== session) return;
        if (!text) continue;
        const bytes = [...encoder.encode(text)];
        const offset = session.bytes.length;
        session.bytes.push(...bytes);
        this.emitOutput(session.id, { offset, bytes });
      }
    });
  }
}
