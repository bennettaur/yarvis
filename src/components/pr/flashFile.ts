/** Set on the element for the length of the flash; styled in `index.css`. */
export const FLASH_CLASS = "yarvis-file-flash";

/**
 * Marks the file a jump just landed on with a brief flash.
 *
 * A smooth scroll ends with the target somewhere in a page of near-identical
 * file headers, and nothing about the landing says which one was asked for. The
 * flash is on the header rather than the whole `<details>`: the header sticks to
 * the top of the review pane, so it stays on screen whether the scroll aimed at
 * the file's top or at a line in the middle of a long diff.
 */
export function flashFile(fileEl: Element | null | undefined): void {
  const el = fileEl?.querySelector("summary") ?? fileEl;
  if (!(el instanceof HTMLElement)) return;
  // Jumping to the file you are already on has to flash again to read as a
  // landing. A class that never left runs no animation, so drop it and force a
  // reflow before re-adding to make the browser start over.
  el.classList.remove(FLASH_CLASS);
  void el.offsetWidth;
  el.classList.add(FLASH_CLASS);
  el.addEventListener("animationend", () => el.classList.remove(FLASH_CLASS), { once: true });
}
