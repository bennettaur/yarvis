import { beforeEach, describe, expect, it } from "bun:test";
import { type PrsPlace, readPrsPlace, writePrsPlace } from "./panelState";
import type { PrSummary } from "./types";

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

describe("readPrsPlace", () => {
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

  it("keeps the stored list when no PR was open", () => {
    writePrsPlace({ provider: "azure", tab: "filters", selected: null });
    expect(readPrsPlace()).toEqual({ provider: "azure", tab: "filters", selected: null });
  });

  it("falls back to the default place on corrupt JSON", () => {
    localStorage.setItem("yarvis.prs.place", "{not json");
    expect(readPrsPlace()).toEqual(defaultPlace);
  });

  it("ignores an unknown provider or tab", () => {
    localStorage.setItem(
      "yarvis.prs.place",
      JSON.stringify({ provider: "gitlab", tab: "archived", selected: null }),
    );
    expect(readPrsPlace()).toEqual(defaultPlace);
  });

  it("drops a selection that isn't a PR summary", () => {
    localStorage.setItem(
      "yarvis.prs.place",
      JSON.stringify({ provider: "github", tab: "review", selected: { title: "no ref" } }),
    );
    expect(readPrsPlace()).toEqual({ provider: "github", tab: "review", selected: null });
  });

  it("drops a selection belonging to a different provider than the restored one", () => {
    localStorage.setItem(
      "yarvis.prs.place",
      JSON.stringify({ provider: "github", tab: "mine", selected: azurePr }),
    );
    expect(readPrsPlace().selected).toBeNull();
  });
});
