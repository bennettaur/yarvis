import { useEffect, useState } from "react";
import { listSpecialists, type Specialist } from "../lib/agents";
import {
  type DecisionOption,
  type DecisionTrial,
  type DecisionTrialResult,
  tryDecision,
} from "../lib/decisionModel";

/**
 * Asks the saved decision model one question, to see how it answers before a
 * feature relies on it. Runs a decision specialist from the agents directory,
 * or instructions written here, against an input and a set of options.
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

/** Reads one option per line, as `value` or `value: what it means`. */
export function parseOptions(text: string): DecisionOption[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon === -1) return { value: line };
      const description = line.slice(colon + 1).trim();
      return {
        value: line.slice(0, colon).trim(),
        ...(description ? { description } : {}),
      };
    });
}

export default function DecisionPlayground() {
  const [specialists, setSpecialists] = useState<Specialist[]>([]);
  /** A decision specialist's name, or "" for instructions written here. */
  const [specialist, setSpecialist] = useState("");
  const [instructions, setInstructions] = useState("");
  const [input, setInput] = useState("");
  const [optionsText, setOptionsText] = useState("");
  const [result, setResult] = useState<DecisionTrialResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    listSpecialists()
      .then((catalog) => setSpecialists(catalog.specialists.filter((s) => s.kind === "decision")))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const chosen = specialists.find((s) => s.name === specialist);
  const options = parseOptions(optionsText);
  // A specialist with its own choices uses them when no options are given.
  const needsOptions = !chosen?.choices.length;
  const ready =
    input.trim().length > 0 &&
    (chosen ? true : instructions.trim().length > 0) &&
    (!needsOptions || options.length >= 2);

  async function run() {
    const trial: DecisionTrial = chosen
      ? { specialist: chosen.name, input, ...(options.length ? { options } : {}) }
      : { instructions, input, options };
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      setResult(await tryDecision(trial));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <select
        aria-label="Decision to try"
        className={FIELD}
        value={specialist}
        onChange={(e) => setSpecialist(e.target.value)}
      >
        <option value="">Instructions written here</option>
        {specialists.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      {chosen ? (
        <p className="text-xs text-zinc-500">{chosen.description}</p>
      ) : (
        <textarea
          aria-label="Instructions"
          className={FIELD}
          rows={3}
          placeholder="What is being decided, and how to judge it"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      )}
      <textarea
        aria-label="Input"
        className={FIELD}
        rows={3}
        placeholder="What to decide about"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <textarea
        aria-label="Options"
        className={`${FIELD} font-mono`}
        rows={3}
        placeholder={
          chosen?.choices.length
            ? `Leave empty to use ${chosen.choices.join(", ")}`
            : "One per line: value, or value: what it means"
        }
        value={optionsText}
        onChange={(e) => setOptionsText(e.target.value)}
      />
      <button
        type="button"
        disabled={!ready || running}
        onClick={() => void run()}
        className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
      >
        {running ? "Asking…" : "Ask"}
      </button>
      {result && (
        <p className="text-sm text-zinc-300">
          <span className="font-mono text-zinc-100">{result.choice}</span>{" "}
          <span className="text-zinc-500">
            {result.reason} ({result.elapsedMs} ms)
          </span>
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
