import { useCallback, useEffect, useState } from "react";
import { getHealth, waitForSidecarReady } from "../lib/api";
import { restartSidecar } from "../lib/keychain";
import {
  getSettings,
  type Settings,
  setAzureDevopsOrgUrl,
  setGoogleClientId,
  setJiraBaseUrl,
  setJiraEmail,
} from "../lib/settings";

/** Trigger a sidecar restart and wait for it to come back ready. */
async function restartAndWait(): Promise<void> {
  let priorUptimeMs: number | undefined;
  try {
    priorUptimeMs = (await getHealth()).uptimeMs;
  } catch {
    // already down — the readiness poll will catch the new process anyway.
  }
  await restartSidecar();
  await waitForSidecarReady({ minUptimeMsBefore: priorUptimeMs });
}

interface SettingMeta {
  key: keyof Pick<Settings, "azureDevopsOrgUrl" | "jiraBaseUrl" | "jiraEmail" | "googleClientId">;
  label: string;
  placeholder: string;
  help: string;
  set: (value: string | null) => Promise<Settings>;
}

/** Non-secret configuration that rides alongside the Keychain credentials in
 * `KeychainSection` but is injected into the sidecar from `settings.rs`'s
 * `~/.yarvis/settings.json` instead — plain values, unlike a secret they can
 * be shown and edited in place rather than only reporting presence. */
const SETTINGS: SettingMeta[] = [
  {
    key: "azureDevopsOrgUrl",
    label: "Azure DevOps org URL",
    placeholder: "https://dev.azure.com/your-org",
    help: "Organization base URL for the PR dashboard. Project is chosen per search.",
    set: setAzureDevopsOrgUrl,
  },
  {
    key: "jiraBaseUrl",
    label: "JIRA base URL",
    placeholder: "https://your-org.atlassian.net",
    help: "Atlassian Cloud site base URL for the Issues dashboard.",
    set: setJiraBaseUrl,
  },
  {
    key: "jiraEmail",
    label: "JIRA email",
    placeholder: "you@example.com",
    help: "Atlassian account email paired with the API token above.",
    set: setJiraEmail,
  },
  {
    key: "googleClientId",
    label: "Google client id",
    placeholder: "...apps.googleusercontent.com",
    help: "Google Cloud OAuth client (Desktop app) id for the calendar integration.",
    set: setGoogleClientId,
  },
];

type Drafts = Record<SettingMeta["key"], string>;

function draftsFrom(settings: Settings): Drafts {
  return Object.fromEntries(SETTINGS.map((meta) => [meta.key, settings[meta.key] ?? ""])) as Drafts;
}

/** Manages the non-secret settings listed in `SETTINGS` above. */
export default function IntegrationSettingsSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [busyKey, setBusyKey] = useState<SettingMeta["key"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((next: Settings) => {
    setSettings(next);
    setDrafts(draftsFrom(next));
  }, []);

  useEffect(() => {
    getSettings()
      .then(adopt)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [adopt]);

  const onSave = useCallback(
    async (meta: SettingMeta) => {
      setBusyKey(meta.key);
      setError(null);
      try {
        const value = drafts?.[meta.key]?.trim() || null;
        adopt(await meta.set(value));
        await restartAndWait();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyKey(null);
      }
    },
    [drafts, adopt],
  );

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Settings</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Stored in <code>~/.yarvis/settings.json</code>, not the Keychain. Saving reloads the sidecar
        so changes take effect right away.
      </p>
      <div className="space-y-5">
        {SETTINGS.map((meta) => (
          <div key={meta.key}>
            <label className="mb-1 block text-sm font-medium">{meta.label}</label>
            <p className="mb-2 text-xs text-zinc-500">{meta.help}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={drafts?.[meta.key] ?? ""}
                placeholder={meta.placeholder}
                onChange={(e) =>
                  setDrafts((prev) => (prev ? { ...prev, [meta.key]: e.target.value } : prev))
                }
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
              />
              <button
                onClick={() => void onSave(meta)}
                disabled={busyKey !== null || settings === null}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
              >
                {busyKey === meta.key ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
