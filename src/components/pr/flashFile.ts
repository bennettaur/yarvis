/**
 * Set on the element for the length of the flash; styled in `index.css`.
 *
 * An attribute rather than a class because React owns the header's `className`
 * — it is rewritten whenever the file folds or unfolds — and a re-render inside
 * the flash would drop a class added from outside React halfway through.
 */
export const FLASH_ATTR = "data-yarvis-flash";

/**
 * Marks the file a jump just landed on with a brief flash.
 *
 * A smooth scroll ends with the target somewhere in a page of near-identical
 * file headers, and nothing about the landing says which one was asked for. The
 * flash is on the header rather than the whole `<details>`: the header sticks to
 * the top of the review pane, so it stays on screen whether the scroll aimed at
 * the file's top or at a line in the middle of a long diff.
 */
export function flashFile(fileEl: Element | null): void {
  const header = fileEl?.querySelector("summary") ?? fileEl;
  if (!(header instanceof HTMLElement)) return;
  // Jumping to the file you are already on has to flash again to read as a
  // landing. An attribute that never left runs no animation, so drop it and
  // force a reflow before re-setting it to make the browser start over.
  header.removeAttribute(FLASH_ATTR);
  void header.offsetWidth;
  header.setAttribute(FLASH_ATTR, "");
  // `animationend` bubbles, so the handler has to check what ended: an
  // animation on anything inside the header would otherwise clear the flash
  // early — and a `once` listener would have spent itself on it.
  const done = (e: AnimationEvent) => {
    if (e.target !== header) return;
    header.removeAttribute(FLASH_ATTR);
    header.removeEventListener("animationend", done);
  };
  header.addEventListener("animationend", done);
}
