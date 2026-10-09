import { COLOR_THEMES, type ColorTheme, setColorTheme, useColorTheme } from "../lib/theme";

/**
 * The colour theme. Stored in the webview rather than `settings.json`, because
 * it is a view preference like the app's split sizes: nothing outside the
 * window reads it.
 */
export default function AppearanceSection() {
  const theme = useColorTheme();
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Color theme
      </h2>
      <p className="mb-4 text-xs text-zinc-500">
        Colors for the whole app, terminals and code included. A change applies straight away and is
        remembered on this computer.
      </p>
      <label className="text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">Theme</span>
        <select
          value={theme}
          onChange={(e) => setColorTheme(e.target.value as ColorTheme)}
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
