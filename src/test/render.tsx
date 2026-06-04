import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * Mounts a React element into a detached DOM node, lets effects, pending
 * promises (e.g. the sidecar fetch), and external-store subscriptions settle,
 * then returns the rendered HTML and unmounts. Keeps component tests to a
 * black-box "render and read the output" shape rather than poking internals.
 */
export async function renderToHtml(element: ReactElement, settleMs = 100): Promise<string> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const html = host.innerHTML;
  root.unmount();
  host.remove();
  return html;
}
