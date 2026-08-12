import { describe, expect, it } from "bun:test";
import { FLASH_CLASS, flashFile } from "./flashFile";

function fileEl(): HTMLElement {
  const details = document.createElement("details");
  details.innerHTML = "<summary>src/a.ts</summary><div>diff</div>";
  document.body.appendChild(details);
  return details;
}

describe("flashFile", () => {
  it("flashes the file's header rather than the whole diff", () => {
    const details = fileEl();
    flashFile(details);
    expect(details.querySelector("summary")?.classList.contains(FLASH_CLASS)).toBe(true);
    expect(details.classList.contains(FLASH_CLASS)).toBe(false);
  });

  it("clears the class once the animation ends, so a later jump can re-run it", () => {
    const details = fileEl();
    const summary = details.querySelector("summary") as HTMLElement;
    flashFile(details);
    summary.dispatchEvent(new Event("animationend"));
    expect(summary.classList.contains(FLASH_CLASS)).toBe(false);

    flashFile(details);
    expect(summary.classList.contains(FLASH_CLASS)).toBe(true);
  });

  // Jumping to the file already on screen is the case the reader most needs
  // marked, and it arrives with the class still set from the previous flash.
  it("re-applies to a file flashed a moment ago", () => {
    const details = fileEl();
    const summary = details.querySelector("summary") as HTMLElement;
    flashFile(details);
    flashFile(details);
    expect(summary.classList.contains(FLASH_CLASS)).toBe(true);
    summary.dispatchEvent(new Event("animationend"));
    expect(summary.classList.contains(FLASH_CLASS)).toBe(false);
  });

  it("falls back to the element itself when it has no header", () => {
    const div = document.createElement("div");
    flashFile(div);
    expect(div.classList.contains(FLASH_CLASS)).toBe(true);
  });

  it("does nothing without an element", () => {
    expect(() => flashFile(null)).not.toThrow();
  });
});
