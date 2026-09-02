import { useCallback, useEffect, useState } from "react";
import { getHealth, waitForSidecarReady } from "../lib/api";
import {
  deleteSecret,
  listSecretStatus,
  restartSidecar,
  type SecretKey,
  type SecretStatus,
  setSecret,
} from "../lib/keychain";
import { formatSecretForDisplay, generateOtpSecret, otpauthUri } from "../lib/otp";
import {
  getSettings,
  type Settings,
  setTelegramAllowedChatIds,
  setTelegramOtpWindowMinutes,
} from "../lib/settings";
import { StatusDot } from "./Dashboard";
import { MaskedInput } from "./MaskedInput";

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

/**
 * Configures the Telegram remote-control bot: a bot token (from @BotFather,
 * Keychain) and the allowlist of chat ids permitted to talk to it (a plain
 * setting in `~/.yarvis/settings.json` — not a credential, so unlike the
 * token it can be shown and edited in place). Saving either reloads the
 * sidecar so the bot picks up the change.
 */
export default function TelegramSection() {
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [token, setToken] = useState("");
  const [chatIds, setChatIds] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A freshly-generated OTP secret being enrolled, held in memory until the user
  // confirms they've added it to their authenticator. Null when not enrolling.
  const [pendingOtpSecret, setPendingOtpSecret] = useState<string | null>(null);
  const [otpWindow, setOtpWindow] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextSecrets, nextSettings] = await Promise.all([listSecretStatus(), getSettings()]);
      setSecrets(nextSecrets);
      setSettingsState(nextSettings);
      setChatIds(nextSettings.telegramAllowedChatIds ?? "");
      setOtpWindow(String(nextSettings.telegramOtpWindowMinutes ?? ""));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isPresent = (key: SecretKey) => secrets.find((s) => s.key === key)?.present ?? false;

  const save = useCallback(
    async (key: SecretKey, value: string, reset: () => void) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setBusy(true);
      try {
        await setSecret(key, trimmed);
        reset();
        await restartAndWait();
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const clear = useCallback(
    async (key: SecretKey) => {
      setBusy(true);
      try {
        await deleteSecret(key);
        await restartAndWait();
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const saveChatIds = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await setTelegramAllowedChatIds(chatIds.trim() || null);
      await restartAndWait();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [chatIds, refresh]);

  // Persist the enrolled OTP secret + window and turn the gate on. The window
  // (a setting) is saved before the secret so the gate never activates with a
  // stale or missing window.
  const enableOtp = useCallback(async () => {
    if (!pendingOtpSecret) return;
    const minutes = otpWindow.trim()
      ? Number(otpWindow)
      : settings?.defaultTelegramOtpWindowMinutes;
    if (minutes === undefined || !Number.isInteger(minutes) || minutes < 1) {
      setError("OTP window must be a whole number of minutes (≥ 1).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setTelegramOtpWindowMinutes(minutes);
      await setSecret("telegram_otp_secret", pendingOtpSecret);
      setPendingOtpSecret(null);
      await restartAndWait();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pendingOtpSecret, otpWindow, refresh, settings]);

  const disableOtp = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteSecret("telegram_otp_secret");
      await setTelegramOtpWindowMinutes(null);
      await restartAndWait();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Telegram</h2>
      <p className="mb-4 text-xs text-zinc-500">
        Chat with Yarvis from Telegram. Create a bot with{" "}
        <span className="text-zinc-300">@BotFather</span>, paste its token below, then message your
        bot <span className="text-zinc-300">/whoami</span> to get your chat id and add it to the
        allowlist. Only listed chat ids can talk to the bot.
      </p>

      <div className="space-y-5">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">Bot token</label>
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <StatusDot state={isPresent("telegram_bot_token")} />
              {isPresent("telegram_bot_token") ? "set" : "not set"}
            </span>
          </div>
          <p className="mb-2 text-xs text-zinc-500">
            The HTTP API token @BotFather gives you (e.g. 123456:ABC-DEF...).
          </p>
          <div className="flex gap-2">
            <MaskedInput
              value={token}
              placeholder="123456:ABC-DEF1234ghIkl..."
              onChange={setToken}
            />
            <button
              onClick={() => void save("telegram_bot_token", token, () => setToken(""))}
              disabled={busy || !token.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => void clear("telegram_bot_token")}
              disabled={busy || !isPresent("telegram_bot_token")}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">Allowed chat ids</label>
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <StatusDot state={!!settings?.telegramAllowedChatIds} />
              {settings?.telegramAllowedChatIds ? "set" : "not set"}
            </span>
          </div>
          <p className="mb-2 text-xs text-zinc-500">
            Comma-separated Telegram chat ids allowed to use the bot. Until one is set, the bot
            replies only to /whoami so you can discover yours.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={chatIds}
              placeholder="123456789, 987654321"
              onChange={(e) => setChatIds(e.target.value)}
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
            <button
              onClick={() => void saveChatIds()}
              disabled={busy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm font-medium">Two-factor unlock (OTP)</label>
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <StatusDot state={isPresent("telegram_otp_secret")} />
              {isPresent("telegram_otp_secret") ? "enabled" : "disabled"}
            </span>
          </div>
          <p className="mb-2 text-xs text-zinc-500">
            Require a one-time code before the bot will act. Send{" "}
            <span className="text-zinc-300">/unlock &lt;code&gt;</span> in Telegram with the current
            code from your authenticator to open a window; it relocks when the window expires and on
            restart.
          </p>

          {pendingOtpSecret ? (
            <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-800/50 p-3">
              <p className="text-xs text-zinc-400">
                Add this to your authenticator app (type the setup key, or paste the otpauth URI),
                then save. The code never leaves your authenticator.
              </p>
              <div>
                <div className="text-xs text-zinc-500">Setup key</div>
                <code className="block break-all text-sm tracking-wide text-zinc-200">
                  {formatSecretForDisplay(pendingOtpSecret)}
                </code>
              </div>
              <div>
                <div className="text-xs text-zinc-500">otpauth URI</div>
                <code className="block break-all text-xs text-zinc-400">
                  {otpauthUri(pendingOtpSecret, "Telegram")}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <label className="text-xs text-zinc-400">Re-auth window (min)</label>
                <input
                  type="number"
                  min={1}
                  value={otpWindow}
                  placeholder={String(settings?.defaultTelegramOtpWindowMinutes ?? "")}
                  onChange={(e) => setOtpWindow(e.target.value)}
                  className="w-24 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500"
                />
                <button
                  onClick={() => void enableOtp()}
                  disabled={busy}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
                >
                  Save & enable
                </button>
                <button
                  onClick={() => setPendingOtpSecret(null)}
                  disabled={busy}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : isPresent("telegram_otp_secret") ? (
            <div className="flex gap-2">
              <button
                onClick={() => setPendingOtpSecret(generateOtpSecret())}
                disabled={busy}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Regenerate
              </button>
              <button
                onClick={() => void disableOtp()}
                disabled={busy}
                className="rounded-md border border-red-900/60 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-40"
              >
                Disable
              </button>
            </div>
          ) : (
            <button
              onClick={() => setPendingOtpSecret(generateOtpSecret())}
              disabled={busy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            >
              Enable OTP
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-400">
          {error} — invoke commands require the app to run under Tauri.
        </p>
      )}
    </section>
  );
}
