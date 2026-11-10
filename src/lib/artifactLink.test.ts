import { describe, expect, it } from "bun:test";
import { parseArtifactLink } from "./artifactLink";

const ID = "6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b";

describe("parseArtifactLink", () => {
  it("reads an artifact link, with or without a trailing slash", () => {
    expect(parseArtifactLink(`yarvis://artifact/${ID}`)).toBe(ID);
    expect(parseArtifactLink(`yarvis://artifact/${ID}/`)).toBe(ID);
  });

  it("rejects anything that isn't exactly one id", () => {
    expect(parseArtifactLink(undefined)).toBeNull();
    expect(parseArtifactLink("yarvis://artifact/")).toBeNull();
    expect(parseArtifactLink(`yarvis://artifact/${ID}/extra`)).toBeNull();
    expect(parseArtifactLink(`yarvis://artifact/${ID}x`)).toBeNull();
    expect(parseArtifactLink(`https://artifact/${ID}`)).toBeNull();
  });
});
