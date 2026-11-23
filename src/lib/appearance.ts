import { loadAttentionAnimation } from "./attentionAnimation";
import { deviceToken, onAuthChange } from "./server";
import { getSettings, type Settings } from "./settings";
import { loadTerminalFontSize } from "./terminalFont";
import { loadColorTheme } from "./theme";

type AppearanceSettings = Pick<Settings, "colorTheme" | "terminalFontSize" | "attentionAnimation">;

interface Deps {
  token: () => Promise<string | null>;
  onAuth: (cb: (signedIn: boolean) => void) => () => void;
  load: () => Promise<AppearanceSettings>;
}

const defaultDeps: Deps = { token: deviceToken, onAuth: onAuthChange, load: getSettings };

async function apply(load: Deps["load"]): Promise<void> {
  try {
    const settings = await load();
    loadColorTheme(settings.colorTheme);
    loadTerminalFontSize(settings.terminalFontSize);
    loadAttentionAnimation(settings.attentionAnimation);
  } catch (e) {
    console.error("[settings] loading appearance failed:", e);
  }
}

/**
 * Applies the saved theme, terminal font size and attention animation. The
 * settings need a signed-in device, so a device that isn't signed in yet
 * resolves straight away and loads them after each sign-in instead. On
 * failure the defaults stand.
 */
export async function loadAppearance(deps: Deps = defaultDeps): Promise<void> {
  deps.onAuth((signedIn) => {
    if (signedIn) void apply(deps.load);
  });
  if (await deps.token()) await apply(deps.load);
}
