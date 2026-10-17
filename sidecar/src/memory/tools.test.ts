import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { PendingQuestions } from "./decisions.ts";
import { HashEmbedder } from "./embedder.ts";
import { PgVectorMemoryStore } from "./index.ts";
import { buildMemoryTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const store = new PgVectorMemoryStore(db, new HashEmbedder());
const tools = buildMemoryTools(store, "session-1");

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await sql`TRUNCATE memories RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("chat memory tools", () => {
  it("remember with validFor stores an expiry measured from now", async () => {
    const before = Date.now();
    const result = (await tools.remember.execute!(
      { content: "GitHub is down", kind: "fact", validFor: "PT1H" },
      opts,
    )) as { id: string; validity: string; validUntil: string };

    expect(result.validity).toBe("current");
    const validUntil = new Date(result.validUntil).getTime();
    expect(validUntil - before).toBeGreaterThanOrEqual(HOUR);
    expect(validUntil - Date.now()).toBeLessThanOrEqual(HOUR);
    expect((await store.get(result.id))?.validUntil?.getTime()).toBe(validUntil);
  });

  it("remember refuses validFor with validUntil and stores nothing", async () => {
    const result = await tools.remember.execute!(
      { content: "x", kind: "fact", validFor: "PT1H", validUntil: "2030-01-01T00:00:00Z" },
      opts,
    );

    expect(result).toEqual({ error: "give validFor or validUntil, not both" });
    expect(await store.count()).toBe(0);
  });

  it("recall reports an expired memory as expired, with its window", async () => {
    await store.add("GitHub is down", {
      validFrom: new Date(Date.now() - 2 * HOUR),
      validUntil: new Date(Date.now() - HOUR),
    });

    const result = (await tools.recall.execute!({ query: "GitHub is down" }, opts)) as {
      results: { validity: string; validUntil?: string }[];
    };
    expect(result.results[0]?.validity).toBe("expired");
    expect(result.results[0]?.validUntil).toBeDefined();
  });

  it("recall asOf a past time finds a memory corrected since", async () => {
    const backThen = new Date(Date.now() - 10 * DAY);
    const original = await store.add("the events project is in design", {
      kind: "project",
      validFrom: backThen,
    });
    await tools.correct_memory.execute!(
      { id: original.id, content: "the events project is shipped" },
      opts,
    );

    const result = (await tools.recall.execute!(
      { query: "events project", asOf: new Date(backThen.getTime() + DAY).toISOString() },
      opts,
    )) as { results: { id: string; validity: string }[] };
    expect(result.results.map((r) => r.id)).toEqual([original.id]);
    expect(result.results[0]?.validity).toBe("current");
  });

  it("confirm_memory on a memory that hasn't started measures from its start", async () => {
    const startsAt = new Date(Date.now() + 7 * DAY);
    const upcoming = await store.add("the user is on vacation", {
      validFrom: startsAt,
      validUntil: new Date(startsAt.getTime() + 7 * DAY),
    });

    const result = (await tools.confirm_memory.execute!(
      { id: upcoming.id, validFor: "P1D" },
      opts,
    )) as { confirmCount: number; validUntil: string };
    expect(result.confirmCount).toBe(1);
    expect(new Date(result.validUntil)).toEqual(new Date(startsAt.getTime() + DAY));
  });

  it("confirm_memory refuses a corrected or unknown memory", async () => {
    const rec = await store.add("GitHub is down");
    await store.supersede(rec.id, "GitHub is back up");

    expect(await tools.confirm_memory.execute!({ id: rec.id }, opts)).toEqual({
      error: "no current memory with that id",
    });
    expect(
      await tools.confirm_memory.execute!({ id: "00000000-0000-4000-8000-000000000000" }, opts),
    ).toEqual({ error: "no current memory with that id" });
  });
});

describe("decision tools", () => {
  const situation = "PR acme/api#12 is ready and waiting on review in the billing project";
  const question = "Should I ask for review in #billing-reviews?";

  type Consulted = {
    verdict: string;
    choice?: string;
    reason?: string;
    basis?: string;
    questionId: string;
    warning?: string;
    precedents: { id: string; similarity: number }[];
  };
  type Recorded = { id?: string; error?: string };
  type Answer = { choice: string; answer?: string; action?: string; validFor?: string };

  let questions: PendingQuestions;
  beforeEach(() => {
    questions = new PendingQuestions();
  });

  /** Each chat turn builds its tools afresh, which is how a later turn is told apart. */
  const newTurn = () => buildMemoryTools(store, "session-1", questions);

  async function consult(turn: ReturnType<typeof newTurn>, action?: string) {
    return (await turn.consult_decisions.execute!(
      { situation, question, action },
      opts,
    )) as Consulted;
  }

  /** Asks in one turn and records the user's answer in the next, as a real exchange does. */
  async function askAndRecord(answer: Answer) {
    const asked = await consult(newTurn(), answer.action);
    return (await newTurn().record_decision.execute!(
      { questionId: asked.questionId, situation, question, ...answer },
      opts,
    )) as Recorded;
  }

  it("decides from an answer recorded in the same situation", async () => {
    const recorded = await askAndRecord({ choice: "post in #billing-reviews", answer: "yes" });

    const result = await consult(newTurn());
    expect(result).toMatchObject({ verdict: "decide", basis: "same-situation" });
    expect(result.choice).toContain("post in #billing-reviews");
    expect(result.warning).toBeString();
    expect(result.precedents.map((p) => p.id)).toEqual([recorded.id!]);
  });

  it("matches a decision by its situation and question, not by the answer stored with it", async () => {
    await askAndRecord({ choice: "post in #billing-reviews", answer: "yes, and tag nobody" });

    const [precedent] = (await consult(newTurn())).precedents;
    expect(precedent?.similarity).toBeCloseTo(1, 3);
  });

  it("asks when no answer was ever recorded", async () => {
    await store.add("The billing project ships next week", { kind: "fact" });

    expect(await consult(newTurn())).toMatchObject({ verdict: "ask", reason: "no-precedent" });
  });

  it("ignores a decision stored with plain remember, which has no answer to weigh", async () => {
    await store.add(`${situation}\nQuestion: ${question}`, { kind: "decision" });

    expect(await consult(newTurn())).toMatchObject({ verdict: "ask", reason: "no-precedent" });
  });

  it("stops counting a decision once its window has passed", async () => {
    const recorded = await askAndRecord({ choice: "post in #billing-reviews", validFor: "PT1H" });
    await sql`UPDATE memories SET valid_from = now() - interval '2 hours', valid_until = now() - interval '1 hour' WHERE id = ${recorded.id!}`;

    expect(await consult(newTurn())).toMatchObject({ verdict: "ask", reason: "no-precedent" });
  });

  it("only weighs answers about the action being asked about", async () => {
    await askAndRecord({ choice: "approve", action: "request_review" });

    expect(await consult(newTurn(), "pick_reviewer")).toMatchObject({
      verdict: "ask",
      reason: "no-precedent",
    });
    expect(await consult(newTurn())).toMatchObject({ verdict: "ask", reason: "no-precedent" });
  });

  it("always asks about a tool that needs the user's go-ahead", async () => {
    expect(await consult(newTurn(), "start_work_on_issue")).toMatchObject({
      verdict: "ask",
      reason: "needs-confirmation",
    });
  });

  it("refuses to record an answer in the turn that asked the question", async () => {
    const turn = newTurn();
    const asked = await consult(turn);

    const result = (await turn.record_decision.execute!(
      { questionId: asked.questionId, situation, question, choice: "approve" },
      opts,
    )) as Recorded;
    expect(result.error).toContain("later turn");
    expect(await store.count({ kinds: ["decision"] })).toBe(0);
  });

  it("refuses an unknown question and records each question once", async () => {
    const asked = await consult(newTurn());
    const record = (questionId: string) =>
      newTurn().record_decision.execute!(
        { questionId, situation, question, choice: "approve" },
        opts,
      ) as Promise<Recorded>;

    expect((await record("made-up")).error).toContain("no open question");
    expect((await record(asked.questionId)).id).toBeString();
    expect((await record(asked.questionId)).error).toContain("no open question");
  });

  it("refuses a bad window and stores nothing", async () => {
    const asked = await consult(newTurn());

    const result = (await newTurn().record_decision.execute!(
      {
        questionId: asked.questionId,
        situation,
        question,
        choice: "approve",
        validFor: "PT1H",
        validUntil: "2030-01-01T00:00:00Z",
      },
      opts,
    )) as Recorded;
    expect(result.error).toBe("give validFor or validUntil, not both");
    expect(await store.count({ kinds: ["decision"] })).toBe(0);
  });

  it("won't correct or confirm a decision, which changes only by being answered again", async () => {
    const recorded = await askAndRecord({ choice: "approve" });
    const tools = newTurn();

    const corrected = (await tools.correct_memory.execute!(
      { id: recorded.id!, content: "decline" },
      opts,
    )) as Recorded;
    const confirmed = (await tools.confirm_memory.execute!({ id: recorded.id! }, opts)) as Recorded;
    expect(corrected.error).toContain("record_decision");
    expect(confirmed.error).toContain("record_decision");
  });
});
