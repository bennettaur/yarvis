import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMutationTestingConfigRoutes,
  DEFAULT_MUTATION_TESTING_CONFIG,
  getMutationTestingConfig,
} from "./mutationConfig.ts";

let dir: string;
let previous: string | undefined;
const app = createMutationTestingConfigRoutes();

const patch = (body: unknown) =>
  app.request("/", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yarvis-mutation-config-"));
  previous = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(() => {
  process.env.YARVIS_SETTINGS_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("mutation testing settings", () => {
  it("starts from the defaults", async () => {
    expect(await (await app.request("/")).json()).toEqual(DEFAULT_MUTATION_TESTING_CONFIG);
  });

  it("saves one field at a time, leaving the others and the rest of the file", async () => {
    writeFileSync(process.env.YARVIS_SETTINGS_PATH as string, JSON.stringify({ other: 1 }));
    expect(await (await patch({ maxMutants: 5 })).json()).toEqual({
      ...DEFAULT_MUTATION_TESTING_CONFIG,
      maxMutants: 5,
    });
    expect(await (await patch({ model: null, maxBudgetUsd: 1.5 })).json()).toEqual({
      model: null,
      maxBudgetUsd: 1.5,
      maxMutants: 5,
    });
    const file = JSON.parse(readFileSync(process.env.YARVIS_SETTINGS_PATH as string, "utf8"));
    expect(file.other).toBe(1);
    expect(file.mutationTesting).toEqual({ model: null, maxBudgetUsd: 1.5, maxMutants: 5 });
  });

  it("refuses values outside the limits, unknown keys and model names that could be flags", async () => {
    for (const body of [
      { maxMutants: 0 },
      { maxMutants: 31 },
      { maxMutants: 2.5 },
      { maxBudgetUsd: 0 },
      { maxBudgetUsd: 100 },
      { model: "--dangerously-skip-permissions" },
      { model: "son net" },
      { turns: 3 },
    ]) {
      expect((await patch(body)).status).toBe(400);
    }
  });

  it("takes full model ids as well as aliases", async () => {
    for (const model of ["claude-opus-4-1[1m]", "us.anthropic.claude-sonnet-4-5-v1:0", "opus"]) {
      const res = await patch({ model });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { model: string }).model).toBe(model);
    }
  });

  it("keeps the valid fields of a hand-edited file and defaults the rest", async () => {
    writeFileSync(
      process.env.YARVIS_SETTINGS_PATH as string,
      JSON.stringify({ mutationTesting: { model: "-x", maxBudgetUsd: 3, maxMutants: "lots" } }),
    );
    expect(await getMutationTestingConfig()).toEqual({
      model: DEFAULT_MUTATION_TESTING_CONFIG.model,
      maxBudgetUsd: 3,
      maxMutants: DEFAULT_MUTATION_TESTING_CONFIG.maxMutants,
    });
  });
});
