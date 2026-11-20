#!/usr/bin/env bun
/**
 * Prints the `VERIFY_ALLOWED_SIGNERS` line for this machine's signing key, so
 * the gate will accept reports it signs. Add the line to the repo variable
 * alongside any others (one per line):
 *
 *   bun run verify:signers
 *   gh variable set VERIFY_ALLOWED_SIGNERS --body "$(bun run --silent verify:signers)"
 *
 * The second form replaces the variable's whole value, so only use it when
 * this is the first key.
 */

import { readFileSync } from "node:fs";
import { allowedSignerLine, localSigner, publicKeyLiteral, REPORT_NAMESPACE } from "./signing.ts";

/** The principal a maintainer's report key goes by, in logs and allowed_signers. */
const REPORT_PRINCIPAL = "verify-pr";

if (import.meta.main) {
  const { key } = localSigner();
  const publicKey =
    publicKeyLiteral(key) ?? readFileSync(key.endsWith(".pub") ? key : `${key}.pub`, "utf8");
  console.log(allowedSignerLine(REPORT_PRINCIPAL, publicKey, REPORT_NAMESPACE));
}
