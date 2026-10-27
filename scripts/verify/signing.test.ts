import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";
import {
  AGENT_REVIEW_NAMESPACE,
  allowedSignerLine,
  REPORT_NAMESPACE,
  signPayload,
  verifiedSigner,
} from "./signing.ts";

// Real keys and the real ssh-keygen, since the format is the point.
const dir = mkdtempSync(join(tmpdir(), "signing-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeKey(name: string) {
  const path = join(dir, name);
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
  return {
    signer: { program: "ssh-keygen", key: path },
    publicKey: readFileSync(`${path}.pub`, "utf8"),
  };
}

const maintainer = makeKey("maintainer");
const reviewer = makeKey("reviewer");
const stranger = makeKey("stranger");

const allowed = [
  allowedSignerLine("verify-pr", maintainer.publicKey, REPORT_NAMESPACE),
  allowedSignerLine("yarvis-merge-reviewer", reviewer.publicKey, AGENT_REVIEW_NAMESPACE),
].join("\n");

describe("signPayload and verifiedSigner", () => {
  it("accepts an allowed key's signature and names its signer", () => {
    const signature = signPayload("report data", REPORT_NAMESPACE, maintainer.signer);
    expect(verifiedSigner("report data", signature, REPORT_NAMESPACE, allowed)).toBe("verify-pr");
  });

  it("refuses a signature over different text", () => {
    const signature = signPayload("report data", REPORT_NAMESPACE, maintainer.signer);
    expect(verifiedSigner("edited data", signature, REPORT_NAMESPACE, allowed)).toBeNull();
  });

  it("refuses a key that isn't allowed", () => {
    const signature = signPayload("report data", REPORT_NAMESPACE, stranger.signer);
    expect(verifiedSigner("report data", signature, REPORT_NAMESPACE, allowed)).toBeNull();
  });

  it("refuses an allowed key signing outside its namespace", () => {
    // The merge reviewer's key may approve, but must not be able to sign a report.
    const signature = signPayload("report data", REPORT_NAMESPACE, reviewer.signer);
    expect(verifiedSigner("report data", signature, REPORT_NAMESPACE, allowed)).toBeNull();
  });

  it("accepts a public key line, the form git's signing key takes", () => {
    const signature = signPayload("data", AGENT_REVIEW_NAMESPACE, {
      program: "ssh-keygen",
      // ssh-keygen finds the private half beside the .pub file it's given.
      key: join(dir, "reviewer.pub"),
    });
    expect(verifiedSigner("data", signature, AGENT_REVIEW_NAMESPACE, allowed)).toBe(
      "yarvis-merge-reviewer",
    );
  });

  it("trusts nobody when no signers are configured, or the signature isn't base64", () => {
    const signature = signPayload("data", REPORT_NAMESPACE, maintainer.signer);
    expect(verifiedSigner("data", signature, REPORT_NAMESPACE, "")).toBeNull();
    expect(verifiedSigner("data", "not base64!", REPORT_NAMESPACE, allowed)).toBeNull();
  });
});

describe("allowedSignerLine", () => {
  it("drops the key comment and git's key:: prefix", () => {
    expect(allowedSignerLine("verify-pr", "key::ssh-ed25519 AAAA me@host", REPORT_NAMESPACE)).toBe(
      'verify-pr namespaces="yarvis-verify" ssh-ed25519 AAAA',
    );
  });
});
