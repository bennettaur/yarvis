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

/**
 * Mounts and leaves it mounted, for tests that have to click something and read
 * what changed — `renderToHtml` returns a static string with nothing live to
 * dispatch on. Call `unmount` from an `afterEach` rather than the end of the
 * test body: a mount left behind by a failed expectation keeps its
 * external-store subscriptions alive and leaks into the next test.
 */
export async function mountForInteraction(
  element: ReactElement,
  settleMs = 100,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
