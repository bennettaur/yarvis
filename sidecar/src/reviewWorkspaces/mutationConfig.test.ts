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
const settingsFile = () => process.env.YARVIS_SETTINGS_PATH as string;

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
    writeFileSync(settingsFile(), JSON.stringify({ other: 1 }));
    expect(await (await patch({ maxMutants: 5 })).json()).toEqual({
      ...DEFAULT_MUTATION_TESTING_CONFIG,
      maxMutants: 5,
    });
    const saved = {
      ...DEFAULT_MUTATION_TESTING_CONFIG,
      maxMutants: 5,
      explanationModel: null,
      planningBudgetUsd: 1.5,
      testTimeoutCapSeconds: 120,
    };
    expect(
      await (
        await patch({ explanationModel: null, planningBudgetUsd: 1.5, testTimeoutCapSeconds: 120 })
      ).json(),
    ).toEqual(saved);
    const file = JSON.parse(readFileSync(settingsFile(), "utf8"));
    expect(file.other).toBe(1);
    expect(file.mutationTesting).toEqual(saved);
  });

  it("takes full model ids as well as aliases", async () => {
    for (const model of ["claude-opus-4-1[1m]", "us.anthropic.claude-sonnet-4-5-v1:0", "opus"]) {
      const res = await patch({ planningModel: model, explanationModel: model });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ planningModel: model, explanationModel: model });
    }
  });

  it("refuses values outside the limits, unknown keys and model names that could be flags", async () => {
    for (const body of [
      { maxMutants: 0 },
      { maxMutants: 31 },
      { maxMutants: 2.5 },
      { planningBudgetUsd: 0 },
      { explanationBudgetUsd: 100 },
      { testTimeoutCapSeconds: 10 },
      { testTimeoutCapSeconds: 7_200 },
      { planningModel: "--dangerously-skip-permissions" },
      { explanationModel: "son net" },
      { model: "sonnet" },
    ]) {
      expect((await patch(body)).status).toBe(400);
    }
  });

  it("keeps the valid fields of a hand-edited file and defaults the rest", async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        mutationTesting: { planningModel: "-x", planningBudgetUsd: 3, maxMutants: "lots" },
      }),
    );
    expect(await getMutationTestingConfig()).toEqual({
      ...DEFAULT_MUTATION_TESTING_CONFIG,
      planningBudgetUsd: 3,
    });
  });
});
