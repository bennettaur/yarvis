import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshPublicKey, sshSign } from "./sshsig.ts";

// The real ssh-keygen checks what this writes, since matching it is the point.
const dir = mkdtempSync(join(tmpdir(), "sshsig-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pem = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

function sshKeygenVerifies(message: string, signature: string, namespace: string): boolean {
  const allowed = join(dir, "allowed");
  const sig = join(dir, "msg.sig");
  writeFileSync(allowed, `reviewer namespaces="${namespace}" ${sshPublicKey(pem)}\n`);
  writeFileSync(sig, signature);
  const result = spawnSync(
    "ssh-keygen",
    ["-Y", "verify", "-f", allowed, "-I", "reviewer", "-n", namespace, "-s", sig],
    { input: message },
  );
  return result.status === 0;
}

describe("sshSign", () => {
  it("writes a signature ssh-keygen accepts", () => {
    const signature = sshSign("agent review data", "yarvis-agent-review", pem);
    expect(sshKeygenVerifies("agent review data", signature, "yarvis-agent-review")).toBe(true);
  });

  it("is refused by ssh-keygen for other text or another namespace", () => {
    const signature = sshSign("agent review data", "yarvis-agent-review", pem);
    expect(sshKeygenVerifies("changed data", signature, "yarvis-agent-review")).toBe(false);
    expect(sshKeygenVerifies("agent review data", signature, "yarvis-verify")).toBe(false);
  });

  it("takes the key as one line of base64 DER, as a Settings field holds it", () => {
    const der = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const pemOfSame = `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`;
    expect(sshPublicKey(der)).toBe(sshPublicKey(pemOfSame));
    expect(sshSign("x", "yarvis-agent-review", der)).toContain("BEGIN SSH SIGNATURE");
  });

  it("refuses a key that isn't Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect(() => sshSign("x", "yarvis-agent-review", rsa)).toThrow("Ed25519");
  });
});
