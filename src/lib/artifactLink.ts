/**
 * Links to an artifact, `yarvis://artifact/<id>`, which the agent puts in its
 * replies (the artifact tools hand it the link). A chat opens one beside the
 * conversation. Anything that isn't exactly that shape is `null`, so a mangled
 * link stays inert.
 */

const PREFIX = "yarvis://artifact/";
const UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

export function parseArtifactLink(href: string | undefined): string | null {
  if (!href?.startsWith(PREFIX)) return null;
  const id = href.slice(PREFIX.length).replace(/\/$/, "");
  return UUID.test(id) ? id.toLowerCase() : null;
}
