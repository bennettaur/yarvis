import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AppPlace } from "../../lib/appPlace";
import { markSetupGuideSeen } from "../../lib/onboarding";
import {
  CheckStep,
  DatabaseStep,
  FinishStep,
  ProviderStep,
  SecretStoreStep,
  WelcomeStep,
} from "./setupSteps";

interface Step {
  label: string;
  render: (leaveFor: (place: AppPlace) => void) => ReactNode;
}

const STEPS: Step[] = [
  { label: "Welcome", render: () => <WelcomeStep /> },
  { label: "Secret store", render: () => <SecretStoreStep /> },
  { label: "Database", render: () => <DatabaseStep /> },
  { label: "LLM provider", render: () => <ProviderStep /> },
  { label: "Check", render: () => <CheckStep /> },
  { label: "Next steps", render: (leaveFor) => <FinishStep onNavigate={leaveFor} /> },
];

/**
 * The first-run setup guide: secret store, database, LLM provider, a check that
 * they work, then pointers to the optional integrations. Each step writes
 * through the same calls the Settings sections use, so finishing here and
 * configuring in Settings leave the app in the same state.
 *
 * Closing it by any route marks it seen, so it never reopens on its own; the
 * Help menu opens it again on request.
 */
export default function SetupGuide({
  open,
  onClose,
  onNavigate,
  onStartTour,
}: {
  open: boolean;
  onClose: () => void;
  /** Leave the guide for a place in the app (an integration's Settings tab). */
  onNavigate: (place: AppPlace) => void;
  onStartTour: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);

  // Reset on close rather than on open, so a reopened guide never paints (and
  // mounts, with its sidecar calls) the step it was last closed on.
  const close = useCallback(() => {
    markSetupGuideSeen();
    setStepIndex(0);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const isLastStep = stepIndex === STEPS.length - 1;
  const leaveFor = (place: AppPlace) => {
    close();
    onNavigate(place);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Set up Yarvis"
        className="flex max-h-[88vh] w-[760px] max-w-[94vw] flex-col rounded-xl border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <span className="text-sm font-medium text-zinc-300">Set up Yarvis</span>
          <ol className="flex flex-1 items-center justify-center gap-1.5" aria-label="Steps">
            {STEPS.map(({ label }, i) => (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => setStepIndex(i)}
                  title={label}
                  aria-label={label}
                  aria-current={i === stepIndex ? "step" : undefined}
                  className={`h-2 w-2 rounded-full ${
                    i === stepIndex
                      ? "bg-indigo-400"
                      : i < stepIndex
                        ? "bg-zinc-500"
                        : "bg-zinc-700"
                  }`}
                />
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={close}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Skip setup
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {STEPS[stepIndex].render(leaveFor)}
        </div>

        <footer className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3">
          <span className="text-xs text-zinc-500">
            Step {stepIndex + 1} of {STEPS.length}: {STEPS[stepIndex].label}
          </span>
          <div className="ml-auto flex gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => setStepIndex(stepIndex - 1)}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Back
              </button>
            )}
            {isLastStep ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onStartTour();
                  }}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  Take the tour
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
                >
                  Done
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setStepIndex(stepIndex + 1)}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
              >
                {stepIndex === 0 ? "Get started" : "Next"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
