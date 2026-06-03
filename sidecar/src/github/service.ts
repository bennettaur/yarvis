import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type GithubFilter, type GithubStar, githubFilters, githubStars } from "../db/schema.ts";

/** Saved PR search filters and starred PRs, persisted in Postgres. */

export function listFilters(db: Db): Promise<GithubFilter[]> {
  return db.select().from(githubFilters).orderBy(desc(githubFilters.createdAt));
}

export async function createFilter(db: Db, name: string, query: string): Promise<GithubFilter> {
  const [row] = await db.insert(githubFilters).values({ name, query }).returning();
  return row!;
}

export async function deleteFilter(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(githubFilters)
    .where(eq(githubFilters.id, id))
    .returning({ id: githubFilters.id });
  return deleted.length > 0;
}

export function listStars(db: Db): Promise<GithubStar[]> {
  return db.select().from(githubStars).orderBy(desc(githubStars.createdAt));
}

export interface StarInput {
  owner: string;
  repo: string;
  number: number;
  title?: string | null;
  url?: string | null;
}

export async function addStar(db: Db, input: StarInput): Promise<void> {
  await db
    .insert(githubStars)
    .values({
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      title: input.title ?? null,
      url: input.url ?? null,
    })
    .onConflictDoNothing();
}

export async function removeStar(
  db: Db,
  owner: string,
  repo: string,
  number: number,
): Promise<boolean> {
  const deleted = await db
    .delete(githubStars)
    .where(
      and(eq(githubStars.owner, owner), eq(githubStars.repo, repo), eq(githubStars.number, number)),
    )
    .returning({ id: githubStars.id });
  return deleted.length > 0;
}
