import { afterEach, describe, expect, it } from "bun:test";
import { FLASH_ATTR, flashFile } from "./flashFile";

const mounted: HTMLElement[] = [];

function fileEl(): HTMLElement {
  const details = document.createElement("details");
  details.innerHTML = "<summary>src/a.ts</summary><div>diff</div>";
  document.body.appendChild(details);
  mounted.push(details);
  return details;
}

const header = (details: HTMLElement) => details.querySelector("summary") as HTMLElement;
const flashing = (el: HTMLElement) => el.hasAttribute(FLASH_ATTR);

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

describe("flashFile", () => {
  it("flashes the file's header rather than the whole diff", () => {
    const details = fileEl();
    flashFile(details);
    expect(flashing(header(details))).toBe(true);
    expect(flashing(details)).toBe(false);
  });

  it("stops flashing once the animation ends", () => {
    const details = fileEl();
    flashFile(details);
    header(details).dispatchEvent(new Event("animationend"));
    expect(flashing(header(details))).toBe(false);
  });

  // Jumping to the file already on screen is the case the reader most needs
  // marked, and it arrives with the flash still set from the previous jump.
  it("re-applies to a file flashed a moment ago", () => {
    const details = fileEl();
    flashFile(details);
    flashFile(details);
    expect(flashing(header(details))).toBe(true);
    header(details).dispatchEvent(new Event("animationend"));
    expect(flashing(header(details))).toBe(false);
  });

  // `animationend` bubbles: a spinner or any other animation inside the header
  // must not be mistaken for the flash finishing.
  it("ignores an animation ending on something inside the header", () => {
    const details = fileEl();
    const spinner = document.createElement("span");
    header(details).appendChild(spinner);
    flashFile(details);
    spinner.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(flashing(header(details))).toBe(true);
  });

  it("falls back to the element itself when it has no header", () => {
    const div = document.createElement("div");
    flashFile(div);
    expect(flashing(div)).toBe(true);
  });

  it("does nothing without an element", () => {
    expect(() => flashFile(null)).not.toThrow();
  });
});
