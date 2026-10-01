import { NAV_ITEMS, type Tab } from "../components/shell/nav";
import { isSettingsTabKey, type SettingsTabKey } from "./settingsTabs";

/**
 * A place in the app a link can send the user: a nav tab, one tab inside
 * Settings, or one of the two guides. The Yarvis guide agent writes these as
 * `yarvis://` links so "where is X?" is answered with a button to X.
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
 * Reads a `yarvis://` link: `yarvis://settings/credentials`, `yarvis://tab/prs`,
 * `yarvis://setup` or `yarvis://tour`. Anything else, including a known prefix
 * with an unknown tab, is `null`, so a mistyped link stays an inert link
 * rather than landing somewhere unexpected.
 */
export function parseAppPlace(href: string | undefined): AppPlace | null {
  if (!href?.startsWith(SCHEME)) return null;
  const [head, sub, ...rest] = href.slice(SCHEME.length).replace(/\/$/, "").split("/");
  if (rest.length > 0) return null;
  if (head === "setup" && sub === undefined) return { kind: "setup" };
  if (head === "tour" && sub === undefined) return { kind: "tour" };
  if (head === "settings") {
    if (sub === undefined) return { kind: "tab", tab: "settings" };
    return isSettingsTabKey(sub) ? { kind: "settings", tab: sub } : null;
  }
  if (head === "tab" && sub !== undefined && isTab(sub)) return { kind: "tab", tab: sub };
  return null;
}
