import { describe, expect, it } from "bun:test";
import { looksLikeEcho } from "./echoFilter";

const REPLY = "The build is green, and the deploy finished a couple of minutes ago.";

describe("looksLikeEcho", () => {
  it("recognises a run of the reply, whatever its case and punctuation", () => {
    expect(looksLikeEcho("The deploy finished a couple of minutes ago", REPLY)).toBe(true);
    expect(looksLikeEcho("build is green", REPLY)).toBe(true);
  });

  it("allows for a misheard word", () => {
    // 6 of 7 pairs match.
    expect(looksLikeEcho("and the deploy finished a couple of minnits", REPLY)).toBe(true);
  });

  it("needs at least 60% of the word pairs to match", () => {
    // 3 of 5 pairs match.
    expect(looksLikeEcho("the deploy broke a couple of", REPLY)).toBe(true);
    // 2 of 4 pairs match.
    expect(looksLikeEcho("the deploy broke a couple", REPLY)).toBe(false);
  });

  it("lets through the user's own words, even when each is a word of the reply", () => {
    expect(looksLikeEcho("stop, check the staging logs first", REPLY)).toBe(false);
    expect(looksLikeEcho("the minutes of the build", REPLY)).toBe(false);
    expect(looksLikeEcho("is the deploy green", REPLY)).toBe(false);
  });

  it("drops a one-word turn that is a word of the reply", () => {
    expect(looksLikeEcho("Green.", REPLY)).toBe(true);
    expect(looksLikeEcho("stop", REPLY)).toBe(false);
  });

  it("never treats an empty transcript or an empty reply as echo", () => {
    expect(looksLikeEcho("", REPLY)).toBe(false);
    expect(looksLikeEcho("the build", "")).toBe(false);
  });
});
