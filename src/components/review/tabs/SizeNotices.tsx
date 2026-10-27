/**
 * What an agent run on a PR will and won't see, said before it starts: the
 * files it gets no diff of, the diffs cut off for their size, and the bulk it
 * only skims, by name, and the estimate against the budget. Shared by the
 * verification report and the "What's changed" summary.
 */

/** Paths named in a notice before the rest fold away. */
const PATHS_SHOWN = 3;

/** A list of paths, the ones past {@link PATHS_SHOWN} behind a "more". */
function PathList({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, PATHS_SHOWN);
  const rest = paths.slice(PATHS_SHOWN);
  return (
    <>
      <span className="font-mono text-xs">{shown.join(", ")}</span>
      {rest.length > 0 && (
        <details className="inline">
          <summary className="inline cursor-pointer"> and {rest.length} more</summary>
          <span className="block font-mono text-xs">{rest.join(", ")}</span>
        </details>
      )}
    </>
  );
}

export interface FileNotice {
  /** The sentence before the list, with its count: "2 binary files have no diff to read". */
  text: string;
  paths: string[];
}

/** One line per kind of file the run won't read whole; nothing when there are none. */
export function FileNotices({ notices }: { notices: FileNotice[] }) {
  const shown = notices.filter((n) => n.paths.length > 0);
  if (shown.length === 0) return null;
  return (
    <div className="space-y-1">
      {shown.map((n) => (
        <div key={n.text}>
          {n.text}: <PathList paths={n.paths} />
        </div>
      ))}
    </div>
  );
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The notices for the binary, cut-off and skimmed files of a PR. */
export function fileNotices(files: {
  binary: string[];
  truncated?: string[];
  noInterdiff?: string[];
  skimmed: string[];
}): FileNotice[] {
  return [
    {
      text: `${count(files.binary.length, "binary file has", "binary files have")} no diff to read`,
      paths: files.binary,
    },
    {
      text: `${count(files.truncated?.length ?? 0, "diff is", "diffs are")} too large and will be cut off, so the agents see only the start`,
      paths: files.truncated ?? [],
    },
    {
      text: `${count(files.noInterdiff?.length ?? 0, "file has", "files have")} a version too large to compare, so no interdiff`,
      paths: files.noInterdiff ?? [],
    },
    {
      text: `${count(files.skimmed.length, "file is", "files are")} bulk (a lockfile, or generated, vendored or minified code) that the agents only skim`,
      paths: files.skimmed,
    },
  ];
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** The estimate against the budget, and what happens past it. */
export function CostLine({
  estimatedCostUsd,
  budgetUsd,
  overBudget,
}: {
  estimatedCostUsd: number;
  budgetUsd: number;
  overBudget: boolean;
}) {
  return (
    <div>
      Estimated cost: about {money(estimatedCostUsd)}, against a budget of {money(budgetUsd)}.
      {overBudget &&
        " The run may hit the budget and stop before it answers; raise it in Settings → PR review first."}
    </div>
  );
}
