import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";

/**
 * Ed25519 signatures in OpenSSH's SSHSIG format, the one `ssh-keygen -Y sign`
 * writes and `ssh-keygen -Y verify` checks. The merge reviewer signs with
 * this, and the verification gate in CI checks with ssh-keygen, so the bytes
 * have to match OpenSSH's PROTOCOL.sshsig exactly. The key is PKCS8, as a
 * PEM or as one line of base64 DER, the form a single-line Settings field can
 * hold; `scripts/verify/agentKey.ts` makes one.
 */

const MAGIC = Buffer.from("SSHSIG");
const HASH = "sha512";

/** An SSH wire-format string: a 4-byte big-endian length, then the bytes. */
function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function loadKey(key: string): KeyObject {
  const text = key.trim();
  return text.startsWith("-----BEGIN")
    ? createPrivateKey(text)
    : createPrivateKey({ key: Buffer.from(text, "base64"), format: "der", type: "pkcs8" });
}

function rawPublicKey(privateKey: string): Buffer {
  const jwk = createPublicKey(loadKey(privateKey)).export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("the signing key must be an Ed25519 key");
  }
  return Buffer.from(jwk.x, "base64url");
}

function publicKeyBlob(privateKey: string): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(rawPublicKey(privateKey))]);
}

/** The key's `ssh-ed25519 AAAA…` line, as an allowed_signers entry names it. */
export function sshPublicKey(privateKey: string): string {
  return `ssh-ed25519 ${publicKeyBlob(privateKey).toString("base64")}`;
}

/**
 * Signs `message` under `namespace` and returns the armored signature that
 * `ssh-keygen -Y sign` would write.
 */
export function sshSign(message: string, namespace: string, privateKey: string): string {
  const key = loadKey(privateKey);
  const digest = createHash(HASH).update(message).digest();
  const signed = Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshString(digest),
  ]);
  // Ed25519 takes no separate digest; the algorithm argument must be null.
  const raw = sign(null, signed, key);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([
    MAGIC,
    version,
    sshString(publicKeyBlob(privateKey)),
    sshString(namespace),
    sshString(""),
    sshString(HASH),
    sshString(Buffer.concat([sshString("ssh-ed25519"), sshString(raw)])),
  ]);
  const lines = blob.toString("base64").match(/.{1,70}/g) ?? [];
  return ["-----BEGIN SSH SIGNATURE-----", ...lines, "-----END SSH SIGNATURE-----", ""].join("\n");
}
