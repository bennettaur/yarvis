/**
 * The tickets a pull request is for: the issues it says it closes, the work
 * items linked to it, Jira keys in its title or branch, and any the reviewer
 * names. The change map and claims checks read them alongside the
 * description.
 *
 * Every request goes to a tracker Yarvis is configured for, through the client
 * built from its settings: a link only says which ticket, never where to ask.
 * The PR's author picks what the PR links and its title, so what they can make
 * Yarvis read with the reviewer's credentials is narrowed: an issue in another
 * repository, or a Jira key on a PR from a fork, is read only when the
 * reviewer names it.
 */

import { orgFromOrgUrl } from "../azure/client.ts";
import { boardsClientFromConfig } from "../azureBoards/client.ts";
import type { Config } from "../config.ts";
import { createGitHubClient } from "../github/client.ts";
import type { IssueDetail } from "../issues/types.ts";
import { jiraClientFromConfig } from "../jira/client.ts";
import { clientError, describeError } from "../llm/errors.ts";
import type { PrCodeSource } from "./source.ts";
import type { PrRef, TicketRef } from "./types.ts";

/** Most tickets one run reads. The rest are noted, and skipped. */
const MAX_TICKETS = 5;
/** Most tickets a reviewer can name for one run. */
export const MAX_NAMED_TICKETS = 5;
const MAX_BODY_CHARS = 4000;
const MAX_COMMENTS = 3;
const MAX_COMMENT_CHARS = 500;

/** A ticket as read from its tracker. The title, body and comments are its authors', not ours. */
interface LoadedTicket {
  key: string;
  title: string;
  url: string;
  body: string;
  comments: { author: string; body: string }[];
}

export interface LinkedTickets {
  tickets: LoadedTicket[];
  /** Tickets named or linked but not read, and why. */
  notes: string[];
}

/** How to read a ticket from each tracker Yarvis is configured for; null where it isn't. */
export interface TicketReaders {
  github: ((owner: string, repo: string, number: number) => Promise<IssueDetail>) | null;
  jira: { host: string; read: (key: string) => Promise<IssueDetail> } | null;
  azure: { org: string; read: (id: number) => Promise<IssueDetail> } | null;
}

export function ticketReaders(config: Pick<Config, "secrets" | "endpoints">): TicketReaders {
  const { githubToken, jiraBaseUrl, azureDevopsOrgUrl } = config.secrets;
  const github = githubToken ? createGitHubClient(config, githubToken) : null;
  const jira = jiraClientFromConfig(config);
  const boards = boardsClientFromConfig(config);
  return {
    github: github ? (owner, repo, number) => github.issueDetail(owner, repo, number) : null,
    // A client exists only when its URL is set; the URL checks only narrow the types.
    jira:
      jira && jiraBaseUrl
        ? { host: new URL(jiraBaseUrl).hostname, read: (key) => jira.issueDetail(key) }
        : null,
    azure:
      boards && azureDevopsOrgUrl
        ? { org: orgFromOrgUrl(azureDevopsOrgUrl), read: (id) => boards.workItemDetail(id) }
        : null,
  };
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/;
/** In a title or branch name, where a key stands on its own between separators. */
const JIRA_KEY_IN_TEXT = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9_]{1,9}-\d{1,7})(?![A-Za-z0-9])/g;
/** A GitHub owner or repository name, so a link can't carry an encoded path into the API URL. */
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** How a ticket is named to the reviewer and the agents. */
function ticketKey(ref: TicketRef, pr?: PrRef): string {
  switch (ref.kind) {
    case "github":
      return pr?.provider === "github" && pr.owner === ref.owner && pr.repo === ref.repo
        ? `#${ref.number}`
        : `${ref.owner}/${ref.repo}#${ref.number}`;
    case "jira":
      return ref.key;
    case "azure":
      return `AB#${ref.id}`;
  }
}

/**
 * The Azure DevOps organization a work item link is on, from either host
 * form. Unlike `orgFromOrgUrl`, any other host gives nothing, so a link
 * elsewhere is refused rather than read as some org.
 */
function azureOrgOf(url: URL, parts: string[]): string | undefined {
  if (url.hostname.endsWith(".visualstudio.com")) return url.hostname.split(".")[0];
  if (url.hostname === "dev.azure.com") return parts[0];
  return undefined;
}

/**
 * A ticket the reviewer named: a GitHub issue link (on github.com, read
 * through whichever GitHub Yarvis is set up for) or `#12` on a GitHub PR, a
 * Jira key or a link on the configured Jira site, or an Azure Boards work item
 * link in the configured organization or `AB#123`.
 */
export function parseTicket(
  input: string,
  pr: PrRef,
  readers: TicketReaders,
): TicketRef | { error: string } {
  const text = input.trim();
  const refused = { error: `${text.slice(0, 80)} isn't a ticket Yarvis can read.` };
  const issue = /^#(\d{1,9})$/.exec(text);
  if (issue && pr.provider === "github") {
    return { kind: "github", owner: pr.owner, repo: pr.repo, number: Number(issue[1]) };
  }
  const workItem = /^AB#(\d{1,9})$/i.exec(text);
  if (workItem) return { kind: "azure", id: Number(workItem[1]) };
  if (JIRA_KEY.test(text)) return { kind: "jira", key: text };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refused;
  }
  if (url.protocol !== "https:") return refused;
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, kind, number] = parts;
  if (
    url.hostname === "github.com" &&
    owner &&
    repo &&
    GITHUB_NAME.test(owner) &&
    GITHUB_NAME.test(repo) &&
    kind === "issues" &&
    /^\d{1,9}$/.test(number ?? "")
  ) {
    return { kind: "github", owner, repo, number: Number(number) };
  }
  if (readers.jira && url.hostname === readers.jira.host) {
    const key = parts[0] === "browse" ? parts[1] : url.searchParams.get("selectedIssue");
    if (key && JIRA_KEY.test(key)) return { kind: "jira", key };
  }
  const workItemsAt = parts.indexOf("_workitems");
  if (readers.azure && workItemsAt >= 0 && parts[workItemsAt + 1] === "edit") {
    const org = azureOrgOf(url, parts);
    const id = Number(parts[workItemsAt + 2]);
    if (org?.toLowerCase() === readers.azure.org.toLowerCase() && Number.isInteger(id) && id > 0) {
      return { kind: "azure", id };
    }
  }
  return refused;
}

/** Jira keys in the PR's title and branch, where teams put them by convention. */
export function jiraKeysIn(...texts: string[]): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(JIRA_KEY_IN_TEXT)) keys.add(match[1] as string);
  }
  return [...keys];
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

async function readTicket(ref: TicketRef, readers: TicketReaders): Promise<IssueDetail> {
  switch (ref.kind) {
    case "github":
      if (!readers.github) throw new Error("GitHub isn't set up");
      return readers.github(ref.owner, ref.repo, ref.number);
    case "jira":
      if (!readers.jira) throw new Error("Jira isn't set up");
      return readers.jira.read(ref.key);
    case "azure":
      if (!readers.azure) throw new Error("Azure Boards isn't set up");
      return readers.azure.read(ref.id);
  }
}

/** The PR as `loadTickets` needs it: where its author can put ticket keys, and whether it's from a fork. */
export interface TicketedPr {
  title: string;
  headRef: string;
  fromFork: boolean;
}

/**
 * The PR's own links, less the ones its author could use to make Yarvis read
 * something the reviewer can see and they can't: an issue in another
 * repository. Those are noted, so the reviewer can name them.
 */
function ownRepoOnly(linked: TicketRef[], pr: PrRef, notes: string[]): TicketRef[] {
  return linked.filter((ref) => {
    const elsewhere =
      ref.kind === "github" &&
      (pr.provider !== "github" || ref.owner !== pr.owner || ref.repo !== pr.repo);
    if (elsewhere) {
      notes.push(
        `Didn't read ${ticketKey(ref, pr)}: it's in another repository. Name it to read it.`,
      );
    }
    return !elsewhere;
  });
}

/**
 * Reads the PR's tickets: the ones the reviewer named first, then the ones the
 * PR links. A ticket that can't be read is noted rather than failing the run,
 * since the description is still worth checking.
 */
export async function loadTickets(
  source: Pick<PrCodeSource, "ref" | "linkedTickets">,
  pr: TicketedPr,
  named: readonly string[],
  readers: TicketReaders,
): Promise<LinkedTickets> {
  const notes: string[] = [];
  const refs: TicketRef[] = [];
  for (const input of named.slice(0, MAX_NAMED_TICKETS)) {
    const parsed = parseTicket(input, source.ref, readers);
    if ("error" in parsed) notes.push(parsed.error);
    else refs.push(parsed);
  }
  const linked = await source.linkedTickets().catch((e) => {
    notes.push(`Couldn't read the PR's linked tickets: ${clientError(e)}`);
    console.error("[tickets] could not read linked tickets:", describeError(e));
    return [] as TicketRef[];
  });
  refs.push(...ownRepoOnly(linked, source.ref, notes));
  if (readers.jira) {
    const keys = jiraKeysIn(pr.title, pr.headRef);
    if (pr.fromFork && keys.length > 0) {
      // Anyone can open a PR from a fork and name any key.
      notes.push(
        `Didn't look up ${keys.join(", ")} from the title or branch: the PR comes from a fork. Name them to read them.`,
      );
    } else {
      refs.push(...keys.map((key): TicketRef => ({ kind: "jira", key })));
    }
  }

  const seen = new Set<string>();
  const unique = refs.filter((ref) => {
    const key = ticketKey(ref, source.ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > MAX_TICKETS) {
    notes.push(`${unique.length - MAX_TICKETS} more linked tickets weren't read.`);
  }

  const loaded = await Promise.all(
    unique.slice(0, MAX_TICKETS).map(async (ref): Promise<LoadedTicket | null> => {
      const key = ticketKey(ref, source.ref);
      try {
        const detail = await readTicket(ref, readers);
        return {
          key,
          title: detail.title,
          url: detail.url,
          body: clip(detail.body, MAX_BODY_CHARS),
          comments: detail.comments.slice(-MAX_COMMENTS).map((c) => ({
            author: c.author,
            body: clip(c.body, MAX_COMMENT_CHARS),
          })),
        };
      } catch (e) {
        // Noted, not thrown: a key found in a branch name may not be a ticket
        // at all, and the description is still worth checking.
        notes.push(`Couldn't read ${key}: ${clientError(e)}`);
        return null;
      }
    }),
  );
  return { tickets: loaded.filter((t): t is LoadedTicket => t !== null), notes };
}
