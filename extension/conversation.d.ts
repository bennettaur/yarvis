export const MAX_TAB_URL_CHARS: number;
export const MAX_TAB_TITLE_CHARS: number;
export const MAX_SELECTION_CHARS: number;
export interface TabContext {
  tabId: number;
  url: string;
  title: string;
  profile: string;
  selection?: string;
}
export function tabContext(
  tab: { id?: number; url?: string; title?: string } | undefined,
  selection: string | undefined,
  profileName: string,
): TabContext | null;
export function titleFor(message: string): string;
export function sessionLabel(session: { title: string | null; updatedAt: string }): string;
