import { useCallback, useEffect, useState } from "react";
import { type DbHealthResponse, getDbHealth, getHealth } from "../../lib/api";
import type { AppPlace } from "../../lib/appPlace";
import { listProviders, type ProviderInfo } from "../../lib/chat";
import { formatError } from "../../lib/errors";
import { listSecretStatus, SECRETS, type SecretKey, setSecret } from "../../lib/keychain";
import { configuredChatProviders } from "../../lib/onboarding";
import { clearResourceCache } from "../../lib/resourceCache";
import { restartAndWait } from "../../lib/restart";
import { getSettings } from "../../lib/settings";
import CustomProviderSection from "../CustomProviderSection";
import { StatusDot } from "../Dashboard";
import { MaskedInput } from "../MaskedInput";
import SecretBackendSection from "../SecretBackendSection";

const DEFAULT_DATABASE_URL =
  SECRETS.find((s) => s.key === "database_url")?.placeholder ?? "postgres://localhost:5432/yarvis";

const errorMessage = (e: unknown): string => formatError(e).message;

/**
 * Saves one secret and restarts the sidecar so it picks the value up. When the
 * restart doesn't come back ready, the sidecar's own startup error (a failed
 * migration, say) is the useful thing to show, not the timeout.
 */
async function saveSecretAndRestart(key: SecretKey, value: string): Promise<void> {
  await setSecret(key, value);
  try {
    await restartAndWait();
  } catch (e) {
    const health = await getHealth().catch(() => null);
    throw new Error(health?.error ?? errorMessage(e));
  } finally {
    // Every cached answer came from the sidecar that just went away.
    clearResourceCache();
  }
}

function useSecretPresent(key: SecretKey): [boolean | null, () => Promise<void>] {
  const [present, setPresent] = useState<boolean | null>(null);
  const refresh = useCallback(async () => {
    try {
      const statuses = await listSecretStatus();
      setPresent(statuses.find((s) => s.key === key)?.present ?? false);
    } catch {
      setPresent(null);
    }
  }, [key]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return [present, refresh];
}

/** Saving one secret from a step: the busy and error state around {@link saveSecretAndRestart}. */
function useSaveSecret(key: SecretKey, afterSave: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await saveSecretAndRestart(key, value);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      await afterSave();
      setBusy(false);
    }
  };
  return { save, busy, error };
}

function StepHeading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="mb-1 text-base font-semibold text-zinc-100">{title}</h2>
      <div className="space-y-2 text-sm text-zinc-400">{children}</div>
    </div>
  );
}

export function WelcomeStep() {
  return (
    <StepHeading title="Welcome to Yarvis">
      <p>
        Yarvis needs three things before it can do anything useful: a place to keep your secrets, a
        PostgreSQL database, and at least one LLM provider. This guide walks through each one.
      </p>
      <p>
        Every step can be skipped and changed later in Settings. You can open this guide again from
        the Help button at the bottom of the nav rail.
      </p>
    </StepHeading>
  );
}

export function SecretStoreStep() {
  return (
    <>
      <StepHeading title="Choose where secrets are kept">
        <p>
          API keys, tokens and the database URL are stored together in one item. Pick the macOS
          Keychain (the default, nothing to install) or 1Password (needs the <code>op</code> CLI).
          Press Save to confirm the choice.
        </p>
      </StepHeading>
      <SecretBackendSection />
    </>
  );
}

export function DatabaseStep() {
  const [present, refreshPresent] = useSecretPresent("database_url");
  const [dbHealth, setDbHealth] = useState<DbHealthResponse | null>(null);
  const [databaseUrl, setDatabaseUrl] = useState("");

  const refreshDb = useCallback(async () => {
    try {
      setDbHealth(await getDbHealth());
    } catch {
      setDbHealth(null);
    }
  }, []);

  useEffect(() => {
    void refreshDb();
  }, [refreshDb]);

  // Offer the default only when nothing is saved, so one click on Save can't
  // replace a working URL (which may carry a password) with the default.
  useEffect(() => {
    if (present === false) setDatabaseUrl((v) => v || DEFAULT_DATABASE_URL);
  }, [present]);

  const { save, busy, error } = useSaveSecret("database_url", () =>
    Promise.all([refreshPresent(), refreshDb()]),
  );
  const onSave = async () => {
    const url = databaseUrl.trim();
    if (url && (await save(url))) setDatabaseUrl("");
  };

  return (
    <>
      <StepHeading title="Connect the database">
        <p>
          Yarvis keeps chat history, memory, tasks and workspaces in a local PostgreSQL database
          with the pgvector extension. If you followed the getting-started guide, the default URL
          below is the one to use.
        </p>
      </StepHeading>
      <div className="flex gap-2">
        <MaskedInput
          value={databaseUrl}
          onChange={setDatabaseUrl}
          placeholder={present ? "Saved. Enter a new URL to replace it." : DEFAULT_DATABASE_URL}
        />
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={busy || !databaseUrl.trim()}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
        >
          {busy ? "Connecting…" : "Save and connect"}
        </button>
      </div>
      <div className="mt-3 flex flex-col gap-1 text-xs text-zinc-400">
        <span className="flex items-center gap-2">
          <StatusDot state={present} />
          {present ? "A database URL is saved" : "No database URL saved yet"}
        </span>
        {dbHealth?.configured && (
          <span className="flex items-center gap-2">
            <StatusDot state={dbHealth.reachable} />
            {dbHealth.reachable ? "Database is reachable" : "Database is not reachable"}
          </span>
        )}
      </div>
      {dbHealth?.configured && !dbHealth.reachable && (
        <p className="mt-3 text-xs text-zinc-500">
          Check that PostgreSQL is running (<code>brew services start postgresql@17</code>) and that
          the database exists (<code>createdb yarvis</code>).
        </p>
      )}
      {error && <p className="mt-3 break-words text-sm text-red-400">{error}</p>}
    </>
  );
}

type ProviderChoice = "anthropic" | "gemini" | "cerebras" | "custom" | "bedrock";

const PROVIDER_CHOICES: { value: ProviderChoice; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "cerebras", label: "Cerebras" },
  { value: "custom", label: "Custom endpoint" },
  { value: "bedrock", label: "AWS Bedrock" },
];

const PROVIDER_SECRET: Partial<Record<ProviderChoice, SecretKey>> = {
  anthropic: "anthropic_api_key",
  gemini: "gemini_api_key",
  cerebras: "cerebras_api_key",
};

/** The API key form for a built-in provider (Anthropic, Gemini, Cerebras). */
function ProviderKeyForm({ secretKey }: { secretKey: SecretKey }) {
  const meta = SECRETS.find((s) => s.key === secretKey);
  const [present, refreshPresent] = useSecretPresent(secretKey);
  const [apiKey, setApiKey] = useState("");
  const { save, busy, error } = useSaveSecret(secretKey, refreshPresent);

  const onSave = async () => {
    const value = apiKey.trim();
    if (value && (await save(value))) setApiKey("");
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium">{meta?.label}</span>
        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <StatusDot state={present} />
          {present ? "set" : "not set"}
        </span>
      </div>
      {meta?.help && <p className="mb-2 text-xs text-zinc-500">{meta.help}</p>}
      <div className="flex gap-2">
        <MaskedInput value={apiKey} onChange={setApiKey} placeholder={meta?.placeholder} />
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={busy || !apiKey.trim()}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <p className="mt-3 break-words text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function ProviderStep() {
  const [choice, setChoice] = useState<ProviderChoice>("anthropic");
  const secretKey = PROVIDER_SECRET[choice];

  return (
    <>
      <StepHeading title="Add an LLM provider">
        <p>
          The assistant needs at least one model to think with. Anthropic is the best-tested option.
          A Gemini key also gives you better memory search and cloud voice. Use a custom endpoint
          for an OpenAI- or Anthropic-compatible gateway such as LiteLLM or Ollama.
        </p>
      </StepHeading>
      <div className="mb-4 flex flex-wrap gap-4">
        {PROVIDER_CHOICES.map((c) => (
          <label key={c.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="setup-provider"
              value={c.value}
              checked={choice === c.value}
              onChange={() => setChoice(c.value)}
            />
            {c.label}
          </label>
        ))}
      </div>
      {secretKey && <ProviderKeyForm key={secretKey} secretKey={secretKey} />}
      {choice === "custom" && <CustomProviderSection />}
      {choice === "bedrock" && (
        <p className="text-sm text-zinc-400">
          Bedrock needs nothing entered here. It uses your normal AWS credentials (
          <code>~/.aws</code>, <code>AWS_PROFILE</code>, and <code>AWS_REGION</code>, which defaults
          to <code>us-east-1</code>), so set those up in your shell and restart Yarvis.
        </p>
      )}
    </>
  );
}

interface CheckResult {
  secretStoreLabel: string;
  databaseConfigured: boolean;
  databaseReachable: boolean;
  providers: ProviderInfo[];
}

async function runChecks(): Promise<CheckResult> {
  const [settings, dbHealth, providers] = await Promise.all([
    getSettings(),
    getDbHealth(),
    listProviders("chat"),
  ]);
  return {
    secretStoreLabel: settings.secretBackend === "onepassword" ? "1Password" : "macOS Keychain",
    databaseConfigured: dbHealth.configured,
    databaseReachable: dbHealth.reachable,
    providers,
  };
}

function databaseDetail(result: CheckResult | null): string {
  if (!result) return "…";
  if (!result.databaseConfigured) return "not configured";
  return result.databaseReachable ? "reachable" : "not reachable";
}

function CheckRow({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 py-2 text-sm last:border-b-0">
      <span className="flex items-center gap-2 text-zinc-300">
        <StatusDot state={ok} />
        {label}
      </span>
      <span className="text-xs text-zinc-500">{detail}</span>
    </div>
  );
}

export function CheckStep() {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await runChecks());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const configured = result ? configuredChatProviders(result.providers) : [];

  return (
    <>
      <StepHeading title="Check it works">
        <p>
          Everything below should be green. If the database or provider is red, go back a step and
          fix it. Once both are green, open Chat, pick a model at the top, and say hello.
        </p>
      </StepHeading>
      <div className="rounded-lg border border-zinc-800 px-3">
        {/* The settings that name the store were read, so there is nothing more
            to check here: a locked store shows up as a failed save on a later step. */}
        <CheckRow
          ok={result ? true : null}
          label="Secret store"
          detail={result?.secretStoreLabel ?? "…"}
        />
        <CheckRow
          ok={result ? result.databaseConfigured && result.databaseReachable : null}
          label="Database"
          detail={databaseDetail(result)}
        />
        <CheckRow
          ok={result ? configured.length > 0 : null}
          label="LLM provider"
          detail={
            !result ? "…" : configured.length ? configured.map((p) => p.label).join(", ") : "none"
          }
        />
      </div>
      <button
        type="button"
        onClick={() => void check()}
        disabled={busy}
        className="mt-3 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        {busy ? "Checking…" : "Check again"}
      </button>
      {error && <p className="mt-3 break-words text-sm text-red-400">{error}</p>}
    </>
  );
}

/** Optional integrations. Keep in step with the table in docs/getting-started.md. */
const OPTIONAL_FEATURES: { label: string; what: string; place: AppPlace }[] = [
  {
    label: "GitHub PRs and issues",
    what: "Save a GitHub token.",
    place: { kind: "settings", tab: "credentials" },
  },
  {
    label: "Workspaces",
    what: "Install Claude Code, then add the repos you work in.",
    place: { kind: "settings", tab: "repos" },
  },
  {
    label: "Azure DevOps and JIRA",
    what: "Save a token and set the organization or site URL.",
    place: { kind: "settings", tab: "credentials" },
  },
  {
    label: "Google Calendar and alarms",
    what: "Create a Google OAuth client, then connect from the Calendar tab.",
    place: { kind: "tab", tab: "calendar" },
  },
  {
    label: "Better memory search",
    what: "Add a Gemini key or configure an embeddings endpoint.",
    place: { kind: "settings", tab: "embeddings" },
  },
  {
    label: "Voice",
    what: "Point speech-to-text and text-to-speech at a provider.",
    place: { kind: "settings", tab: "voice" },
  },
  {
    label: "MCP servers",
    what: "Connect Yarvis to other tools.",
    place: { kind: "settings", tab: "tools" },
  },
  {
    label: "Telegram",
    what: "Create a bot with @BotFather and save its token.",
    place: { kind: "settings", tab: "telegram" },
  },
  {
    label: "Transcript digest",
    what: "Let the assistant learn from your Claude Code sessions.",
    place: { kind: "settings", tab: "assistant" },
  },
];

export function FinishStep({ onNavigate }: { onNavigate: (place: AppPlace) => void }) {
  return (
    <>
      <StepHeading title="You're set up">
        <p>
          Everything else is optional. Set up the integrations you want, in any order. Once chat
          works, you can also ask the assistant things like "where do I add a GitHub token?" and it
          will point you to the right place.
        </p>
      </StepHeading>
      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {OPTIONAL_FEATURES.map((f) => (
          <li key={f.label} className="flex items-center justify-between gap-3 px-3 py-2">
            <div>
              <div className="text-sm text-zinc-200">{f.label}</div>
              <div className="text-xs text-zinc-500">{f.what}</div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate(f.place)}
              className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Open
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
