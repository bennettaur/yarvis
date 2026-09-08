import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

/**
 * The text a fragment of markup reads as. Syntax coloring wraps code in a span
 * per token, so an assertion about what a line *says* has to go through the
 * text rather than matching the HTML around it.
 *
 * Parsed by the DOM rather than by stripping tags with a regex: the DOM is
 * what the assertion is really about, it decodes the entities highlight.js
 * escapes, and a tag-shaped regex over HTML is a well-known way to get a
 * subtly wrong answer.
 */
export function textOf(html: string): string {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.textContent ?? "";
}

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

/**
 * Mounts and returns the text of the first frame React commits, still mounted so
 * the caller can tear it down once whatever it was holding open is released.
 * `renderToHtml` waits for everything to settle, which is exactly what a test
 * about *not* having to wait cannot do — a cached list must be on screen before
 * the sidecar answers.
 *
 * Forced synchronous: let React schedule the commit and a resolved-from-cache
 * microtask could land first, hiding the very frame this is about.
 */
export function firstPaintOf(element: ReactElement): {
  text: string;
  unmount: () => void;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(element));
  return {
    text: host.textContent ?? "",
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
