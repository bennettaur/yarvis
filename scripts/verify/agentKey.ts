#!/usr/bin/env bun
/**
 * Makes a signing key for the Yarvis merge reviewer. It prints two lines:
 *
 * 1. The private key, as one line of base64. Paste it into Yarvis under
 *    Settings → Credentials → "Merge reviewer signing key", then restart the
 *    sidecar. It isn't stored anywhere else, so clear your terminal after.
 * 2. Its `VERIFY_ALLOWED_SIGNERS` line, limited to agent reviews. Add it to
 *    the repo variable beside the line from `verify:signers`.
 *
 *   bun run verify:agent-key
 */

import { generateKeyPairSync } from "node:crypto";
import { sshPublicKey } from "../../sidecar/src/verify/sshsig.ts";
import { AGENT_REVIEW_NAMESPACE, allowedSignerLine } from "./signing.ts";

/** The principal the merge reviewer's key goes by, in logs and allowed_signers. */
const AGENT_PRINCIPAL = "yarvis-merge-reviewer";

if (import.meta.main) {
  const privateKey = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");
  console.log(`Private key (Settings → Credentials):\n${privateKey}\n`);
  console.log(
    `VERIFY_ALLOWED_SIGNERS line:\n${allowedSignerLine(AGENT_PRINCIPAL, sshPublicKey(privateKey), AGENT_REVIEW_NAMESPACE)}`,
  );
}
