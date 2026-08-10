import { beforeEach, describe, expect, it } from "bun:test";
import { type PrsPlace, readPrsPlace, writePrsPlace } from "./panelState";
import type { PrSummary } from "./types";

const STORAGE_KEY = "yarvis.prs.place";

const githubPr: PrSummary = {
  ref: { provider: "github", owner: "octo", repo: "repo", number: 7 },
  title: "Add a thing",
  url: "https://github.com/octo/repo/pull/7",
  author: "octo",
  draft: false,
  state: "open",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

const azurePr: PrSummary = {
  ref: { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 42 },
  title: "Fix the cart",
  url: "https://dev.azure.com/acme/Shop/_git/web/pullrequest/42",
  author: "someone",
  draft: false,
  state: "active",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

const defaultPlace: PrsPlace = { provider: "github", tab: "mine", selected: null };

/** Writes a raw slot, for the malformed inputs `writePrsPlace` can't produce. */
function store(place: unknown): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(place));
}

describe("the PRs panel place", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to the GitHub 'My PRs' list when nothing is stored", () => {
    expect(readPrsPlace()).toEqual(defaultPlace);
  });

  it("round-trips a place through storage", () => {
    const place: PrsPlace = { provider: "github", tab: "reviewing", selected: githubPr };
    writePrsPlace(place);
    expect(readPrsPlace()).toEqual(place);
  });

  it("keeps a selection belonging to the restored provider", () => {
    writePrsPlace({ provider: "azure", tab: "filters", selected: azurePr });
    expect(readPrsPlace()).toEqual({ provider: "azure", tab: "filters", selected: azurePr });
  });

  it("overwrites an earlier place", () => {
    writePrsPlace({ provider: "github", tab: "reviewing", selected: githubPr });
    writePrsPlace({ provider: "github", tab: "review", selected: null });
    expect(readPrsPlace()).toEqual({ provider: "github", tab: "review", selected: null });
  });

  it("falls back to the default place on corrupt JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readPrsPlace()).toEqual(defaultPlace);
  });

  it("falls back to the default place when the slot isn't an object", () => {
    localStorage.setItem(STORAGE_KEY, "3");
    expect(readPrsPlace()).toEqual(defaultPlace);
  });

  it("keeps the stored provider when only the tab is unknown", () => {
    store({ provider: "azure", tab: "archived", selected: null });
    expect(readPrsPlace()).toEqual({ provider: "azure", tab: "mine", selected: null });
  });

  it("keeps the stored tab when only the provider is unknown", () => {
    store({ provider: "gitlab", tab: "review", selected: null });
    expect(readPrsPlace()).toEqual({ provider: "github", tab: "review", selected: null });
  });

  it("drops a selection that isn't a PR summary", () => {
    store({ provider: "github", tab: "review", selected: { title: "no ref" } });
    expect(readPrsPlace()).toEqual({ provider: "github", tab: "review", selected: null });
  });

  it("drops a selection whose ref can't identify a PR", () => {
    store({
      provider: "github",
      tab: "mine",
      selected: { ...githubPr, ref: { provider: "github" } },
    });
    expect(readPrsPlace().selected).toBeNull();
  });

  it("drops a selection whose PR number isn't a number", () => {
    store({
      provider: "github",
      tab: "mine",
      selected: { ...githubPr, ref: { ...githubPr.ref, number: "7/../../../api/azure/pr/x/y/1" } },
    });
    expect(readPrsPlace().selected).toBeNull();
  });

  it("drops a selection with a non-http url", () => {
    store({
      provider: "github",
      tab: "mine",
      selected: { ...githubPr, url: "javascript:alert(1)" },
    });
    expect(readPrsPlace().selected).toBeNull();
  });

  it("drops a selection belonging to a different provider than the restored one", () => {
    store({ provider: "github", tab: "mine", selected: azurePr });
    expect(readPrsPlace().selected).toBeNull();
  });
});
