import { describe, expect, it } from "bun:test";
import { parsePrLink } from "./prLink";

describe("parsePrLink", () => {
  it("reads a GitHub pull request URL", () => {
    const pr = parsePrLink("https://github.com/bennettaur/yarvis/pull/12/files", "Fix it");
    expect(pr?.ref).toEqual({
      provider: "github",
      owner: "bennettaur",
      repo: "yarvis",
      number: 12,
    });
    expect(pr?.title).toBe("Fix it");
  });

  it("reads an Azure DevOps pull request URL", () => {
    const pr = parsePrLink("https://dev.azure.com/acme/Proj%20A/_git/app/pullrequest/7");
    expect(pr?.ref).toEqual({
      provider: "azure",
      org: "acme",
      project: "Proj A",
      repo: "app",
      prId: 7,
    });
  });

  it("reads a legacy visualstudio.com pull request URL", () => {
    const pr = parsePrLink("https://acme.visualstudio.com/Proj/_git/app/pullrequest/7");
    expect(pr?.ref).toEqual({
      provider: "azure",
      org: "acme",
      project: "Proj",
      repo: "app",
      prId: 7,
    });
  });

  it("ignores links that are not pull requests", () => {
    expect(parsePrLink("https://github.com/bennettaur/yarvis/issues/12")).toBeNull();
    expect(parsePrLink("https://example.test/o/r/pull/1")).toBeNull();
    expect(parsePrLink("http://github.com/o/r/pull/1")).toBeNull();
    expect(parsePrLink("not a url")).toBeNull();
    expect(parsePrLink(undefined)).toBeNull();
  });

  it("ignores a PR number that isn't a positive integer", () => {
    expect(parsePrLink("https://github.com/o/r/pull/0")).toBeNull();
    expect(parsePrLink("https://github.com/o/r/pull/-1")).toBeNull();
    expect(parsePrLink("https://github.com/o/r/pull/")).toBeNull();
  });

  it("doesn't throw on a malformed percent-escape in the path", () => {
    expect(parsePrLink("https://example.test/50%-off")).toBeNull();
    expect(parsePrLink("https://github.com/o/r/pull/12%")).toBeNull();
  });
});
