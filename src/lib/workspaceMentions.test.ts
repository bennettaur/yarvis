import { describe, expect, it } from "bun:test";
import { parseWorkspaceLink, splitWorkspaceMentions } from "./workspaceMentions";

const A = "0b8f3c1e-2d4a-4e6b-9c7d-1a2b3c4d5e6f";
const B = "11111111-2222-4333-8444-555555555555";
const NAMES = new Map([
  [A, "Billing"],
  [B, "Search"],
]);

describe("splitWorkspaceMentions", () => {
  it("splits around every known id, keeping the text between them", () => {
    expect(splitWorkspaceMentions(`${A} then ${B.toUpperCase()}, then ${A}.`, NAMES)).toEqual([
      { workspaceId: A, name: "Billing" },
      " then ",
      { workspaceId: B, name: "Search" },
      ", then ",
      { workspaceId: A, name: "Billing" },
      ".",
    ]);
  });

  it("leaves unknown ids and ids inside a path as text", () => {
    const text = `22222222-2222-4333-8444-555555555555 and https://x.test/w/${A}`;
    expect(splitWorkspaceMentions(text, NAMES)).toEqual([text]);
  });
});

describe("parseWorkspaceLink", () => {
  it("reads the id, lowercased", () => {
    expect(parseWorkspaceLink(`yarvis://workspace/${A.toUpperCase()}`)).toBe(A);
  });

  it("refuses anything but a bare id after the scheme", () => {
    expect(parseWorkspaceLink(`yarvis://workspace/${A}/x`)).toBeNull();
    expect(parseWorkspaceLink(`yarvis://workspace/${A}?q=1`)).toBeNull();
    expect(parseWorkspaceLink(`https://workspace/${A}`)).toBeNull();
    expect(parseWorkspaceLink(undefined)).toBeNull();
  });
});
