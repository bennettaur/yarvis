import { describe, expect, it } from "bun:test";
import { looksLikeEcho } from "./echoFilter";

const REPLY = "The build is green, and the deploy finished a couple of minutes ago.";

describe("looksLikeEcho", () => {
  it("recognises a fragment of the reply, whatever its case and punctuation", () => {
    expect(looksLikeEcho("The deploy finished a couple of minutes ago", REPLY)).toBe(true);
    expect(looksLikeEcho("build is green", REPLY)).toBe(true);
  });

  it("lets through the user's own words said over the reply", () => {
    expect(looksLikeEcho("stop, check the staging logs first", REPLY)).toBe(false);
    // Mostly the reply's words, but not enough of them.
    expect(looksLikeEcho("the deploy broke staging again", REPLY)).toBe(false);
  });

  it("never treats an empty transcript or an empty reply as echo", () => {
    expect(looksLikeEcho("", REPLY)).toBe(false);
    expect(looksLikeEcho("the build", "")).toBe(false);
  });
});
