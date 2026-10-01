import { useEffect, useState } from "react";
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

const STEPS = ["Welcome", "Secret store", "Database", "LLM provider", "Check", "Next steps"];

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
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      markSetupGuideSeen();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const close = () => {
    markSetupGuideSeen();
    onClose();
  };
  const last = step === STEPS.length - 1;

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
            {STEPS.map((label, i) => (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  title={label}
                  aria-label={label}
                  aria-current={i === step ? "step" : undefined}
                  className={`h-2 w-2 rounded-full ${
                    i === step ? "bg-indigo-400" : i < step ? "bg-zinc-500" : "bg-zinc-700"
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
          {step === 0 && <WelcomeStep />}
          {step === 1 && <SecretStoreStep />}
          {step === 2 && <DatabaseStep />}
          {step === 3 && <ProviderStep />}
          {step === 4 && <CheckStep />}
          {step === 5 && (
            <FinishStep
              onNavigate={(place) => {
                close();
                onNavigate(place);
              }}
            />
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3">
          <span className="text-xs text-zinc-500">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </span>
          <div className="ml-auto flex gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Back
              </button>
            )}
            {last ? (
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
                onClick={() => setStep(step + 1)}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
              >
                {step === 0 ? "Get started" : "Next"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
