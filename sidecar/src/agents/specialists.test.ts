import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import {
  BUILTIN_SPECIALISTS,
  findSpecialist,
  listSpecialists,
  resetSpecialist,
  seedBuiltinSpecialists,
  updateSpecialist,
} from "./specialists.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE agent_specialists RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("built-in specialists", () => {
  it("seeds the shipped set once and is idempotent afterwards", async () => {
    const first = await seedBuiltinSpecialists(db);
    expect(first.inserted).toBe(BUILTIN_SPECIALISTS.length);
    expect((await seedBuiltinSpecialists(db)).inserted).toBe(0);
    expect((await listSpecialists(db)).length).toBe(BUILTIN_SPECIALISTS.length);
  });

  it("leaves a user's edit to a built-in prompt alone on the next seed", async () => {
    await seedBuiltinSpecialists(db);
    const planner = await findSpecialist(db, "planner");
    await updateSpecialist(db, planner!.id, { prompt: "my own wording" });

    await seedBuiltinSpecialists(db);
    expect((await findSpecialist(db, "planner"))?.prompt).toBe("my own wording");
  });

  it("resets an edited built-in back to its shipped definition", async () => {
    await seedBuiltinSpecialists(db);
    const planner = await findSpecialist(db, "planner");
    await updateSpecialist(db, planner!.id, { prompt: "my own wording", maxSteps: 1 });

    const reset = await resetSpecialist(db, "planner");
    const shipped = BUILTIN_SPECIALISTS.find((s) => s.name === "planner")!;
    expect(reset?.prompt).toBe(shipped.prompt);
    expect(reset?.maxSteps).toBe(shipped.maxSteps);
  });

  it("finds a specialist case-insensitively and reports an unknown one as null", async () => {
    await seedBuiltinSpecialists(db);
    expect((await findSpecialist(db, "Work-Scout"))?.name).toBe("work-scout");
    expect(await findSpecialist(db, "nobody")).toBeNull();
    expect(await resetSpecialist(db, "nobody")).toBeNull();
  });

  it("can disable one so it stops being offered", async () => {
    await seedBuiltinSpecialists(db);
    const scout = await findSpecialist(db, "work-scout");
    await updateSpecialist(db, scout!.id, { enabled: false });

    const enabled = await listSpecialists(db, { enabledOnly: true });
    expect(enabled.map((s) => s.name)).not.toContain("work-scout");
  });

  /**
   * A specialist naming a tool the run then strips is a description that
   * over-promises: the model reads a prompt telling it to do something it has no
   * tool for. Either the tool belongs in the list or the prompt shouldn't claim it.
   */
  it("names no tool that a delegated run would strip", async () => {
    const { selectTools } = await import("./run.ts");
    const { builtinToolMetadata } = await import("../chat/builtinTools.ts");
    const all = builtinToolMetadata();
    for (const specialist of BUILTIN_SPECIALISTS) {
      const kept = Object.keys(selectTools(all, specialist.toolIds));
      expect(kept.length, `${specialist.name} lost a tool it asks for`).toBe(
        specialist.toolIds.length,
      );
    }
  });

  it("only names tools that actually exist", async () => {
    const { builtinToolMetadata } = await import("../chat/builtinTools.ts");
    const names = new Set(Object.keys(builtinToolMetadata()));
    for (const specialist of BUILTIN_SPECIALISTS) {
      for (const id of specialist.toolIds) {
        expect(names.has(id.replace("builtin:", "")), `${specialist.name} → ${id}`).toBe(true);
      }
    }
  });
});
