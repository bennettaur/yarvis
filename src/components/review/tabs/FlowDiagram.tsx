import { useEffect, useState } from "react";
import type { VerificationFlow } from "../../../lib/reviewWorkspaces/verification";

/** The flowchart forms the flow agent is told to write; anything else is shown as source only. */
const FLOWCHART = /^(flowchart|graph)\s/;

let renders = 0;

/**
 * Renders model-written Mermaid to an SVG image. The source comes from an
 * agent that read the PR's code, so Mermaid runs in strict mode (labels
 * escaped, no click handlers) and its SVG is shown through an `<img>`, where
 * it can neither run script nor load anything.
 */
async function renderSvg(source: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "dark",
  });
  renders += 1;
  const { svg } = await mermaid.render(`verification-flow-${renders}`, source);
  return svg;
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The report's flow section: the diagram, what it shows, and its source to fall back on. */
export default function FlowDiagram({ flow }: { flow: VerificationFlow }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = flow.mermaid;

  useEffect(() => {
    let live = true;
    setSvg(null);
    setError(null);
    if (!source) return;
    if (!FLOWCHART.test(source)) {
      setError("The diagram isn't a flowchart, so it isn't drawn.");
      return;
    }
    renderSvg(source)
      .then((out) => live && setSvg(out))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [source]);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-zinc-200">{flow.title}</p>
      <p className="text-xs text-zinc-400">{flow.explanation}</p>
      {svg && (
        <img
          src={svgUrl(svg)}
          alt={flow.title}
          className="max-w-full rounded border border-zinc-800 bg-zinc-950 p-2"
        />
      )}
      {error && <p className="text-xs text-amber-300">Couldn't draw the diagram: {error}</p>}
      {source && (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Mermaid source</summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">
            {source}
          </pre>
        </details>
      )}
    </div>
  );
}
