import { useState } from "react";
import { COLOR_THEMES, type ColorTheme, setColorTheme, useColorTheme } from "../lib/theme";

/** The colour theme, saved to `settings.json` as it is chosen. */
export default function AppearanceSection() {
  const theme = useColorTheme();
  const [error, setError] = useState<string | null>(null);

  const choose = (next: ColorTheme) => {
    setError(null);
    setColorTheme(next).catch((e) =>
      setError(`Applied, but couldn't be saved, so it won't survive a restart: ${String(e)}`),
    );
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Color theme
      </h2>
      <p className="mb-4 text-xs text-zinc-500">
        Colors for the whole app, terminals and code included. A change applies straight away and is
        kept after a restart.
      </p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <label className="text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">Theme</span>
        <select
          value={theme}
          onChange={(e) => choose(e.target.value as ColorTheme)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
        >
          {COLOR_THEMES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
