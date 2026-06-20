import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type AzureDevopsFilter,
  type AzureDevopsStar,
  azureDevopsFilters,
  azureDevopsStars,
} from "../db/schema.ts";

/** Saved Azure DevOps PR searches and starred PRs, persisted in Postgres. */

export function listFilters(db: Db): Promise<AzureDevopsFilter[]> {
  return db.select().from(azureDevopsFilters).orderBy(desc(azureDevopsFilters.createdAt));
}

export async function createFilter(
  db: Db,
  name: string,
  scope: string,
  project: string | null,
): Promise<AzureDevopsFilter> {
  const [row] = await db.insert(azureDevopsFilters).values({ name, scope, project }).returning();
  return row!;
}

export async function deleteFilter(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(azureDevopsFilters)
    .where(eq(azureDevopsFilters.id, id))
    .returning({ id: azureDevopsFilters.id });
  return deleted.length > 0;
}

export function listStars(db: Db): Promise<AzureDevopsStar[]> {
  return db.select().from(azureDevopsStars).orderBy(desc(azureDevopsStars.createdAt));
}

export interface StarInput {
  org: string;
  project: string;
  repo: string;
  prId: number;
  title?: string | null;
  url?: string | null;
}

export async function addStar(db: Db, input: StarInput): Promise<void> {
  await db
    .insert(azureDevopsStars)
    .values({
      org: input.org,
      project: input.project,
      repo: input.repo,
      prId: input.prId,
      title: input.title ?? null,
      url: input.url ?? null,
    })
    .onConflictDoNothing();
}

export async function removeStar(
  db: Db,
  org: string,
  project: string,
  repo: string,
  prId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(azureDevopsStars)
    .where(
      and(
        eq(azureDevopsStars.org, org),
        eq(azureDevopsStars.project, project),
        eq(azureDevopsStars.repo, repo),
        eq(azureDevopsStars.prId, prId),
      ),
    )
    .returning({ id: azureDevopsStars.id });
  return deleted.length > 0;
}
