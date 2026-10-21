import { NAV_ITEMS, type Tab } from "../components/shell/nav";
import { isSettingsTabKey, type SettingsTabKey } from "./settingsTabs";

/**
 * A place in the app a link can send the user: a nav tab, one tab inside
 * Settings, the setup guide, or the app tour. The yarvis-guide agent writes
 * these as `yarvis://` links so "where is X?" is answered with a button to X.
 */
export type AppPlace =
  | { kind: "tab"; tab: Tab }
  | { kind: "settings"; tab: SettingsTabKey }
  | { kind: "setup" }
  | { kind: "tour" };

const SCHEME = "yarvis://";

function isTab(value: string): value is Tab {
  return NAV_ITEMS.some((item) => item.id === value);
}

/**
 * Reads a `yarvis://` link: `yarvis://settings/credentials`, `yarvis://settings`
 * (the Settings page), `yarvis://tab/prs`, `yarvis://setup` or `yarvis://tour`,
 * with an optional trailing slash. Anything else, including a known prefix with
 * an unknown tab, is `null`, so a mistyped link stays an inert link rather than
 * landing somewhere unexpected.
 */
export function parseAppPlace(href: string | undefined): AppPlace | null {
  if (!href?.startsWith(SCHEME)) return null;
  const [section, name, ...rest] = href.slice(SCHEME.length).replace(/\/$/, "").split("/");
  if (rest.length > 0) return null;
  if (section === "setup" && name === undefined) return { kind: "setup" };
  if (section === "tour" && name === undefined) return { kind: "tour" };
  if (section === "settings") {
    if (name === undefined) return { kind: "tab", tab: "settings" };
    return isSettingsTabKey(name) ? { kind: "settings", tab: name } : null;
  }
  if (section === "tab" && name !== undefined && isTab(name)) return { kind: "tab", tab: name };
  return null;
}
