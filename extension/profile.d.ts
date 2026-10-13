export const PROFILE_KEY: string;
export const MAX_NAME_CHARS: number;
export function loadProfile(): Promise<{ id: string; name: string }>;
export function cleanName(name: string): string | null;
export function saveProfileName(name: string): Promise<{ id: string; name: string } | null>;
