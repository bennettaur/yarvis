import { useState } from "react";
import { setAttentionAnimation, useAttentionAnimation } from "../lib/attentionAnimation";
import { COLOR_THEMES, type ColorTheme, setColorTheme, useColorTheme } from "../lib/theme";

const SAVE_FAILED = "Applied, but couldn't be saved, so it won't survive a restart:";

/** The colour theme and the top bar's attention animation, each saved to `settings.json` as it is chosen. */
export default function AppearanceSection() {
  return (
    <div className="space-y-5">
      <ColorThemeSection />
      <AttentionAnimationSection />
    </div>
  );
}

function ColorThemeSection() {
  const theme = useColorTheme();
  const [error, setError] = useState<string | null>(null);

  const choose = (next: ColorTheme) => {
    setError(null);
    setColorTheme(next).catch((e) => setError(`${SAVE_FAILED} ${String(e)}`));
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

function AttentionAnimationSection() {
  const enabled = useAttentionAnimation();
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setError(null);
    setAttentionAnimation(!enabled).catch((e) => setError(`${SAVE_FAILED} ${String(e)}`));
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-500">Attention</h2>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={enabled} onChange={toggle} className="mt-1" />
        <span className="text-sm text-zinc-300">
          Animate the top bar while something needs attention
          <span className="mt-0.5 block text-xs text-zinc-500">
            An amber band crosses the top bar and the bell shakes every few seconds while the bell
            has something pending. The bell shows its count either way.
          </span>
        </span>
      </label>
    </section>
  );
}
