import { desc } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  customProviders,
  embeddingsConfig,
  type GithubPrConfigRow,
  githubPrConfig,
  type JobConfigRow,
  jobConfig,
  mcpServers,
  providerModels,
  voiceConfig,
  wipConfig,
} from "../db/schema.ts";
import { readSection, withSection } from "./store.ts";

/**
 * One-time copy of the seven small, rarely-changing Postgres config tables
 * (`custom_providers` + `provider_models`, `mcp_servers`, `voice_config`,
 * `embeddings_config`, `wip_config`, `github_pr_config`, `job_config`) into
 * `~/.yarvis/settings.json`, so the sidecar can read/write them directly
 * without a database.
 *
 * Gated by `structuralSettingsMigrated` in the settings file, mirroring
 * `keychain_settings_migrated` in `src-tauri/src/settings.rs` — it only ever
 * runs once, so a config edit made after migration (which from then on only
 * touches the settings file) is never overwritten by a stale Postgres
 * snapshot on a later restart.
 *
 * The Postgres tables themselves are left in place, untouched and unused
 * after this runs, so the migration can be verified against real data before
 * a follow-up drops them.
 */
export async function migrateStructuralConfig(db: Db): Promise<void> {
  if (await readSection<boolean>("structuralSettingsMigrated")) return;

  const [providerRows, modelRows, serverRows, voiceRows, embeddingsRows, wipRows, prRows, jobRows] =
    await Promise.all([
      db.select().from(customProviders),
      db.select().from(providerModels),
      db.select().from(mcpServers),
      db.select().from(voiceConfig).orderBy(desc(voiceConfig.updatedAt)).limit(1),
      db.select().from(embeddingsConfig).orderBy(desc(embeddingsConfig.updatedAt)).limit(1),
      db.select().from(wipConfig).orderBy(desc(wipConfig.updatedAt)).limit(1),
      db.select().from(githubPrConfig).orderBy(desc(githubPrConfig.updatedAt)).limit(1),
      db.select().from(jobConfig).orderBy(desc(jobConfig.updatedAt)).limit(1),
    ]);

  const iso = (value: Date | string): string => new Date(value).toISOString();

  if (providerRows.length > 0) {
    await withSection<Record<string, unknown>, void>("customProviders", () => ({
      next: Object.fromEntries(
        providerRows.map((row) => [
          row.id,
          {
            id: row.id,
            name: row.name,
            baseUrl: row.baseUrl,
            apiKind: row.apiKind,
            models: row.models,
            headerNames: row.headerNames,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          },
        ]),
      ),
      result: undefined,
    }));
  }

  if (modelRows.length > 0) {
    const byProvider = new Map<string, unknown[]>();
    for (const row of modelRows) {
      const entries = byProvider.get(row.providerId) ?? [];
      entries.push({
        modelId: row.modelId,
        capabilities: row.capabilities,
        enabled: row.enabled,
        sortOrder: row.sortOrder,
      });
      byProvider.set(row.providerId, entries);
    }
    await withSection<Record<string, unknown[]>, void>("providerModels", () => ({
      next: Object.fromEntries(byProvider),
      result: undefined,
    }));
  }

  if (serverRows.length > 0) {
    await withSection<Record<string, unknown>, void>("mcpServers", () => ({
      next: Object.fromEntries(
        serverRows.map((row) => [
          row.id,
          {
            id: row.id,
            name: row.name,
            transport: row.transport,
            url: row.url,
            command: row.command,
            args: row.args,
            headerNames: row.headerNames,
            oauth: row.oauth,
            oauthScope: row.oauthScope,
            enabled: row.enabled,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          },
        ]),
      ),
      result: undefined,
    }));
  }

  const voiceRow = voiceRows[0];
  if (voiceRow) {
    await withSection<unknown, void>("voiceConfig", () => ({
      next: {
        sttProvider: voiceRow.sttProvider,
        sttModel: voiceRow.sttModel,
        sttLanguage: voiceRow.sttLanguage,
        ttsProvider: voiceRow.ttsProvider,
        ttsModel: voiceRow.ttsModel,
        ttsVoice: voiceRow.ttsVoice,
        ttsRefAudio: voiceRow.ttsRefAudio,
        ttsExtras: voiceRow.ttsExtras,
        speakReplies: voiceRow.speakReplies,
        handsFree: voiceRow.handsFree,
      },
      result: undefined,
    }));
  }

  const embeddingsRow = embeddingsRows[0];
  if (embeddingsRow) {
    await withSection<unknown, void>("embeddingsConfig", () => ({
      next: {
        baseUrl: embeddingsRow.baseUrl,
        model: embeddingsRow.model,
        apiKind: embeddingsRow.apiKind,
        dimensions: embeddingsRow.dimensions,
        headerNames: embeddingsRow.headerNames,
      },
      result: undefined,
    }));
  }

  const wipRow = wipRows[0];
  if (wipRow) {
    await withSection<unknown, void>("wipConfig", () => ({
      next: { sources: wipRow.sources, issueLabels: wipRow.issueLabels },
      result: undefined,
    }));
  }

  const prRow: GithubPrConfigRow | undefined = prRows[0];
  if (prRow) {
    await withSection<unknown, void>("githubPrConfig", () => ({
      next: { reviewQuery: prRow.reviewQuery, reviewingLookbackDays: prRow.reviewingLookbackDays },
      result: undefined,
    }));
  }

  const jobRow: JobConfigRow | undefined = jobRows[0];
  if (jobRow) {
    await withSection<unknown, void>("jobConfig", () => ({
      next: {
        ccDigestEnabled: jobRow.ccDigestEnabled,
        ccDigestProjectDirs: jobRow.ccDigestProjectDirs,
      },
      result: undefined,
    }));
  }

  await withSection<boolean, void>("structuralSettingsMigrated", () => ({
    next: true,
    result: undefined,
  }));
}
