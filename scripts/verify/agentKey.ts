#!/usr/bin/env bun
/**
 * Makes a signing key for the Yarvis merge reviewer. The private key goes to a
 * file only you can read, not the terminal, since a terminal's scrollback (or
 * an agent's transcript) would keep it. Paste the file's one line into Yarvis
 * under Settings → Credentials → "Merge reviewer signing key", restart the
 * sidecar, then delete the file.
 *
 * It prints the key's `VERIFY_ALLOWED_SIGNERS` line, limited to agent reviews,
 * to add to the repo variable beside the line from `verify:signers`.
 *
 *   bun run verify:agent-key [--out merge-reviewer.key]
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sshPublicKey } from "../../sidecar/src/verify/sshsig.ts";
import { AGENT_PRINCIPAL } from "./gate.ts";
import { AGENT_REVIEW_NAMESPACE, allowedSignerLine } from "./signing.ts";

if (import.meta.main) {
  const { values } = parseArgs({
    options: { out: { type: "string", default: "merge-reviewer.key" } },
  });
  const out = resolve(values.out as string);

  const privateKey = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");
  // "wx" refuses an existing file or symlink, which 0o600 wouldn't apply to.
  writeFileSync(out, `${privateKey}\n`, { mode: 0o600, flag: "wx" });
  console.log(
    `Private key written to ${out}. Paste it into Settings → Credentials, then delete it.\n`,
  );
  console.log(
    `VERIFY_ALLOWED_SIGNERS line:\n${allowedSignerLine(AGENT_PRINCIPAL, sshPublicKey(privateKey), AGENT_REVIEW_NAMESPACE)}`,
  );
}
