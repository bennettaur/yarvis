/**
 * Registers the native-messaging host with Chrome:
 *
 *   bun run browser:install <extension-id> [<extension-id> ...]
 *
 * Chrome only starts a host named in a manifest under its NativeMessagingHosts
 * directory, and only for the extension ids that manifest allows — which is what
 * stops any other extension from reaching the sidecar through it. The manifest's
 * `path` must be a single executable (no arguments), and Chrome starts it with a
 * minimal PATH, so a small wrapper pins the absolute path of this Bun.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const HOST_NAME = "com.yarvis.browser";

const EXTENSION_ID = /^[a-p]{32}$/;

export function hostManifest(hostPath: string, extensionIds: string[]) {
  return {
    name: HOST_NAME,
    description: "Lets Yarvis read the pages open in this Chrome",
    path: hostPath,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

export function wrapperScript(bunPath: string, hostScript: string): string {
  // Quoted so a path with spaces survives; both are ours, not user input at run time.
  return `#!/bin/sh\nexec "${bunPath}" "${hostScript}"\n`;
}

if (import.meta.main) {
  const ids = process.argv.slice(2);
  if (ids.length === 0 || ids.some((id) => !EXTENSION_ID.test(id))) {
    console.error(
      "usage: bun run browser:install <extension-id> [...]\n" +
        "The id is the 32-letter one chrome://extensions shows under the loaded Yarvis extension.",
    );
    process.exit(1);
  }

  const wrapperPath = join(homedir(), ".yarvis", "browser", "yarvis-browser-host");
  const manifestPath = join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${HOST_NAME}.json`,
  );

  await mkdir(dirname(wrapperPath), { recursive: true });
  await writeFile(
    wrapperPath,
    wrapperScript(process.execPath, resolve(import.meta.dir, "host.ts")),
  );
  await chmod(wrapperPath, 0o755);

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(hostManifest(wrapperPath, ids), null, 2)}\n`);

  console.log(`Wrote ${manifestPath}\nRestart Chrome (or reload the extension) to pick it up.`);
}
