import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { Tab } from "../shell/nav";
import { formatChord } from "../shell/shortcuts";
import { tabShortcutDigit } from "../shell/useTabShortcuts";
import { TOUR_STEPS, type TourStep } from "./tourSteps";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_WIDTH = 320;
// The tallest card, so one near the bottom of the rail stays fully on screen.
const CARD_MAX_HEIGHT = 220;
const CARD_GAP = 12;
const RING_PAD = 4;

/** A page step highlights its own nav button unless it names another target. */
function targetOf(step: TourStep): string | undefined {
  return step.target ?? step.tab;
}

function chordOf(step: TourStep): string | null {
  const key = step.shortcutKey ?? (step.tab ? tabShortcutDigit(step.tab) : null);
  return key ? formatChord(["Mod", key]) : null;
}

function targetRect(target: string | undefined): Rect | null {
  if (!target) return null;
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * Keeps the card beside its target, on screen. The targets are all on the nav
 * rail at the left edge, so the card goes to the right and only needs clamping
 * vertically.
 */
function cardPosition(rect: Rect): { top: number; left: number } {
  const top = Math.max(
    CARD_GAP,
    Math.min(rect.top - CARD_GAP, window.innerHeight - CARD_MAX_HEIGHT),
  );
  const left = Math.min(
    rect.left + rect.width + CARD_GAP,
    window.innerWidth - CARD_WIDTH - CARD_GAP,
  );
  return { top, left };
}

/**
 * The app tour: steps through {@link TOUR_STEPS}, switching to each page and
 * ringing its nav-rail button. A step whose target isn't on screen shows its
 * card centered instead of failing, so a button whose `data-tour` value changes
 * costs a highlight, not the tour.
 */
export default function Tour({
  open,
  onClose,
  onTabChange,
}: {
  open: boolean;
  onClose: () => void;
  onTabChange: (tab: Tab) => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = TOUR_STEPS[index];
  const isLastStep = index === TOUR_STEPS.length - 1;

  // Reset on close rather than on open: the effect below would otherwise switch
  // to the page of the step the tour last ended on before the reset landed.
  const close = useCallback(() => {
    setIndex(0);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (open && step.tab) onTabChange(step.tab);
  }, [open, step, onTabChange]);

  // Measured in a layout effect so the ring is placed before the frame paints,
  // and again on resize because the bottom group of rail buttons moves with the
  // window height.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setRect(targetRect(targetOf(step)));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, step]);

  const next = useCallback(() => {
    if (isLastStep) close();
    else setIndex((i) => i + 1);
  }, [isLastStep, close]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return;
    // Capture phase so the Terminal's xterm, shown on one of the steps, can't
    // swallow the keys first. Enter is left alone so it still presses whichever
    // card button has focus.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, next, back]);

  if (!open) return null;

  const chord = chordOf(step);
  const position = rect ? cardPosition(rect) : null;

  return (
    <div className="fixed inset-0 z-50" aria-live="polite">
      {/* Blocks clicks on the app underneath; the tour drives navigation. */}
      <div className={`absolute inset-0 ${rect ? "" : "bg-black/55"}`} />
      {rect && (
        <div
          data-tour-highlight
          className="pointer-events-none absolute rounded-lg ring-2 ring-indigo-400"
          style={{
            top: rect.top - RING_PAD,
            left: rect.left - RING_PAD,
            width: rect.width + RING_PAD * 2,
            height: rect.height + RING_PAD * 2,
            // Dims everything outside the ring.
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
          }}
        />
      )}
      <div
        role="dialog"
        aria-label={`Tour: ${step.title}`}
        className={`absolute rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl ${
          position ? "" : "left-1/2 top-1/3 -translate-x-1/2"
        }`}
        style={{ width: CARD_WIDTH, ...(position ?? {}) }}
      >
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-sm font-semibold">{step.title}</h2>
          {chord && (
            <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
              {chord}
            </kbd>
          )}
          <span className="ml-auto text-xs text-zinc-500">
            {index + 1} / {TOUR_STEPS.length}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-zinc-400">{step.body}</p>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={close}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            End tour
          </button>
          <div className="ml-auto flex gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={back}
                className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium hover:bg-indigo-500"
            >
              {isLastStep ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
