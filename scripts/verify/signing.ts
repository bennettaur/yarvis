/**
 * SSH signatures on what the gate acts on: verification reports, signed on a
 * maintainer's machine, and the Yarvis merge reviewer's approvals. A report
 * posted from a trusted GitHub account only proves someone had that account's
 * token. A signature proves it came from a machine holding the key, which a
 * test run with the maintainer's `gh` login can't fake.
 *
 * Signing and checking both go through `ssh-keygen -Y`, the format git uses
 * for SSH-signed commits, so a maintainer's existing git signing key (in
 * 1Password, say) works as is.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";

/**
 * Each kind of signed text has its own namespace, and `VERIFY_ALLOWED_SIGNERS`
 * limits each key to one, so a key trusted for one kind can't sign the other.
 */
export const REPORT_NAMESPACE = "yarvis-verify";
export const AGENT_REVIEW_NAMESPACE = "yarvis-agent-review";

function withScratch<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "verify-sig-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A git config value, with a leading `~` expanded as git does for paths. */
function gitConfigPath(key: string): string {
  return run("git", ["config", "--get", "--type=path", key], { allowFailure: true }).stdout.trim();
}

/** The public key line in a signing key setting, or `null` if it names a file. */
export function publicKeyLiteral(key: string): string | null {
  const literal = key.replace(/^key::/, "").trim();
  return /^(ssh-|ecdsa-|sk-)/.test(literal) ? literal : null;
}

/**
 * The key and program to sign with: `yarvis.verifySigningKey` if set, else the
 * git SSH signing key, through `gpg.ssh.program` (1Password's `op-ssh-sign`,
 * for one) or plain `ssh-keygen`.
 */
export function localSigner(): { program: string; key: string } {
  const key = gitConfigPath("yarvis.verifySigningKey") || gitConfigPath("user.signingkey");
  if (!key) {
    throw new Error(
      "no signing key: set git's SSH user.signingkey, or yarvis.verifySigningKey to a public key",
    );
  }
  return { program: gitConfigPath("gpg.ssh.program") || "ssh-keygen", key };
}

/**
 * Signs `payload` and returns the armored signature, base64-encoded so it
 * fits on one line of a comment. `key` is a public key line (git's `key::`
 * form too) whose private half is in the agent, or a key file's path.
 */
export function signPayload(payload: string, namespace: string, signer = localSigner()): string {
  return withScratch((dir) => {
    const payloadFile = join(dir, "payload");
    writeFileSync(payloadFile, payload);
    let keyFile = signer.key;
    // For a key given as a public key line, the private half is in the agent;
    // `-U` says so, as git does when it signs a commit.
    const agentOnly: string[] = [];
    const literal = publicKeyLiteral(signer.key);
    if (literal) {
      keyFile = join(dir, "key.pub");
      writeFileSync(keyFile, `${literal}\n`);
      agentOnly.push("-U");
    }
    run(signer.program, ["-Y", "sign", "-n", namespace, "-f", keyFile, ...agentOnly, payloadFile]);
    return Buffer.from(readFileSync(`${payloadFile}.sig`, "utf8")).toString("base64");
  });
}

/**
 * The principal from `allowedSigners` whose key made `signature` over
 * `payload` in `namespace`, or `null` if none did. `allowedSigners` is an
 * OpenSSH allowed_signers file, normally the `VERIFY_ALLOWED_SIGNERS` variable.
 */
export function verifiedSigner(
  payload: string,
  signature: string,
  namespace: string,
  allowedSigners: string,
): string | null {
  if (!allowedSigners.trim() || !/^[A-Za-z0-9+/=]+$/.test(signature)) return null;
  return withScratch((dir) => {
    const allowed = join(dir, "allowed_signers");
    const sig = join(dir, "payload.sig");
    writeFileSync(allowed, `${allowedSigners.trim()}\n`);
    writeFileSync(sig, Buffer.from(signature, "base64"));

    const found = run(
      "ssh-keygen",
      ["-Y", "find-principals", "-f", allowed, "-s", sig, "-n", namespace],
      { allowFailure: true },
    );
    if (found.status !== 0) return null;
    // A key listed under several names gives several; any of them proves it.
    for (const principal of found.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      const checked = run(
        "ssh-keygen",
        ["-Y", "verify", "-f", allowed, "-I", principal, "-n", namespace, "-s", sig],
        { input: payload, allowFailure: true },
      );
      if (checked.status === 0) return principal;
    }
    return null;
  });
}

/** The allowed_signers line for a public key, limited to one namespace. */
export function allowedSignerLine(principal: string, publicKey: string, namespace: string): string {
  const key = publicKey
    .replace(/^key::/, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  return `${principal} namespaces="${namespace}" ${key}`;
}
