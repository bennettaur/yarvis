import { useState } from "react";
import type { IssueProvider } from "../lib/issues/types";
import GithubIssuesView from "./issue/GithubIssuesView";
import JiraIssuesView from "./issue/JiraIssuesView";

/**
 * The Issues panel. A provider toggle switches the whole panel between issue
 * sources — GitHub and JIRA today — each rendering its own view. The toggle is
 * built to extend to further providers (Linear, Azure DevOps) by adding an entry
 * here and a matching view.
 */
const PROVIDERS: { key: IssueProvider; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "jira", label: "JIRA" },
];

export default function IssuesPanel() {
  const [provider, setProvider] = useState<IssueProvider>("github");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-800 px-6 pb-2 pt-3">
        <div className="inline-flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setProvider(p.key)}
              className={`rounded-md px-3 py-1 text-sm ${
                provider === p.key
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {provider === "github" ? <GithubIssuesView /> : <JiraIssuesView />}
      </div>
    </div>
  );
}
