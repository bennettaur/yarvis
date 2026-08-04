import { describe, expect, it } from "bun:test";
import { detectSecret } from "./screening.ts";

/**
 * Assembled rather than written inline: a literal in the real digits-and-alnum
 * shape trips GitHub's own push-protection scanner, which blocks the commit even
 * though the value is invented.
 */
const SLACK_SHAPED = ["xoxb", "EXAMPLE", "PLACEHOLDER", "TOKEN"].join("-");

describe("detectSecret", () => {
  it("flags provider tokens by their prefix", () => {
    const cases: Array<[string, string]> = [
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
      ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz", "github-token"],
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
      [SLACK_SHAPED, "slack-token"],
      ["AIzaSyA0bcdefghijklmnopqrstuvwxyz012345", "google-api-key"],
      ["sk_live_abcdefghijklmnopqrst", "stripe-key"],
      ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm-token"],
      ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "api-key"],
    ];
    for (const [text, kind] of cases) {
      expect(detectSecret(text)?.kind).toBe(kind);
    }
  });

  it("flags a PEM private key block", () => {
    const text = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END";
    expect(detectSecret(text)?.kind).toBe("private-key");
  });

  it("flags a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(detectSecret(jwt)?.kind).toBe("jwt");
  });

  it("flags a URL with an embedded password", () => {
    expect(detectSecret("postgres://yarvis:hunter2@localhost:5432/db")?.kind).toBe(
      "credential-url",
    );
  });

  it("flags an inline credential assignment", () => {
    expect(detectSecret("PASSWORD=correcthorse")?.kind).toBe("credential-assignment");
    expect(detectSecret('curl -H "x-api-key: 8f3ba91c22de"')?.kind).toBe("auth-header");
  });

  it("flags a long random-looking token with no recognizable prefix", () => {
    expect(detectSecret("Zm9vYmFy8QxK2mNpQ7rT4vWyA1sD3fG6hJ0kL9zX")?.kind).toBe(
      "high-entropy-token",
    );
  });

  it("allows the identifiers the clipboard book exists to hold", () => {
    const allowed = [
      "3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31",
      "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
      "https://github.com/bennettaur/yarvis/issues/176",
      "kubectl -n production get pods --selector app=yarvis",
      "mbennett@wealthsimple.com",
      "Michael Bennett",
    ];
    for (const text of allowed) {
      expect(detectSecret(text)).toBeNull();
    }
  });

  it("allows a command whose credential is a variable reference", () => {
    expect(
      detectSecret('curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com'),
    ).toBeNull();
    expect(detectSecret("export PGPASSWORD=$DB_PASSWORD")).toBeNull();
  });

  it("finds a credential embedded in a longer snippet", () => {
    const text = [
      "# deploy notes",
      "gh auth login --with-token ghp_0123456789abcdefghijKLMNOP",
    ].join("\n");
    expect(detectSecret(text)?.kind).toBe("github-token");
  });
});
