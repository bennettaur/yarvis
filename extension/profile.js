// This Chrome profile's identity as Yarvis sees it.

export const PROFILE_KEY = "profile";
export const MAX_NAME_CHARS = 40;

let creating = null;

/**
 * The id is made once and kept, so renaming the profile doesn't make Yarvis
 * think a new browser arrived. The default name is meant to be replaced.
 */
export async function loadProfile() {
  const stored = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
  if (stored?.id && stored?.name) return stored;
  // Two first-run callers (the hello and a storage change) must not mint two ids.
  creating ??= (async () => {
    const id = crypto.randomUUID();
    const profile = { id, name: `profile-${id.slice(0, 4)}` };
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    return profile;
  })();
  return creating;
}

/** Null when the name has nothing usable left in it. The sidecar's route cleans it the same way. */
export function cleanName(name) {
  const cleaned = String(name)
    .replace(/[\p{C}]/gu, "")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return cleaned || null;
}

export async function saveProfileName(name) {
  const cleaned = cleanName(name);
  if (!cleaned) return null;
  const profile = await loadProfile();
  const next = { ...profile, name: cleaned };
  await chrome.storage.local.set({ [PROFILE_KEY]: next });
  return next;
}
