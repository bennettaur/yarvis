import { afterEach, describe, expect, it } from "bun:test";
import { mountForInteraction, waitFor } from "../../test/render";
import { Conversation, ConversationContent, ConversationScrollButton } from "./conversation";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const SCROLL_BUTTON = 'button[aria-label="Scroll to the newest message"]';

/**
 * happy-dom has no layout, so the scroll pane is given a fixed size and a
 * scrollTop that holds whatever is set, standing in for a thread taller than
 * its pane.
 */
function giveLayout(pane: HTMLElement) {
  let scrollTop = 900;
  Object.defineProperty(pane, "scrollHeight", { value: 1000 });
  Object.defineProperty(pane, "clientHeight", { value: 100 });
  Object.defineProperty(pane, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return (to: number) => {
    scrollTop = to;
    pane.dispatchEvent(new Event("scroll"));
  };
}

describe("Conversation", () => {
  it("offers a jump to the newest message only after the user scrolls up", async () => {
    const mounted = await mountForInteraction(
      <Conversation>
        <ConversationContent>
          <p>a long thread</p>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>,
    );
    cleanup = mounted.unmount;
    const pane = mounted.host.querySelector<HTMLElement>('[role="log"] > div');
    if (!pane) throw new Error("no scroll pane");
    expect(mounted.host.querySelector(SCROLL_BUTTON)).toBeNull();

    const scrollTo = giveLayout(pane);
    // use-stick-to-bottom only lets go on a scroll upward from the last position
    // it saw, so it first has to see the pane at the bottom.
    scrollTo(899);
    scrollTo(300);
    await waitFor(() => mounted.host.querySelector(SCROLL_BUTTON) !== null, "the scroll button");

    mounted.host.querySelector<HTMLButtonElement>(SCROLL_BUTTON)?.click();
    await waitFor(() => mounted.host.querySelector(SCROLL_BUTTON) === null, "the button to go");
    // The scroll eases in, so wait for it to be well on its way rather than exactly there.
    await waitFor(() => pane.scrollTop > 800, "the pane to scroll toward the newest message");
  });
});
