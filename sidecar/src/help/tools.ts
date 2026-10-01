import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import { availableProviders } from "../llm/providers.ts";
import { docNames, readDoc, searchDocs } from "./docs.ts";

const isSet = (value: string | undefined): boolean => !!value;

/**
 * Help tools the Yarvis guide answers "where is X?" and "how do I set up Y?"
 * from. `search_yarvis_docs` and `read_yarvis_doc` read the embedded user docs.
 * `yarvis_setup_status` reports whether each part of the app is configured,
 * never the values, so no secret leaves the sidecar.
 */
export function buildHelpTools(config: Config) {
  return {
    search_yarvis_docs: tool({
      description:
        "Search Yarvis's own user documentation for how to use or configure the app: where a setting lives, what a page does, how to connect an integration. Returns the best-matching sections with a snippet of each; follow up with read_yarvis_doc for the full text.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(300)
          .describe("What the user wants to do or find, in plain words"),
      }),
      execute: async ({ query }) => {
        const matches = searchDocs(query);
        return matches.length > 0
          ? { matches }
          : { matches, note: `Nothing matched. The pages are: ${docNames().join(", ")}.` };
      },
    }),

    read_yarvis_doc: tool({
      description:
        "Read one page of Yarvis's user documentation, or only the sections whose heading contains `section`. Page names are the `doc` values search_yarvis_docs returns, such as `configuration` or `features/pr-review`.",
      inputSchema: z.object({
        doc: z.string().min(1).max(80).describe("Page name, e.g. `configuration`"),
        section: z
          .string()
          .max(120)
          .optional()
          .describe("Part of a heading to narrow to, e.g. `Token scopes`"),
      }),
      execute: async ({ doc, section }) => {
        const result = readDoc(doc, section);
        if (!result) return { error: `No page named "${doc}".`, pages: docNames() };
        return result;
      },
    }),

    yarvis_setup_status: tool({
      description:
        "Which parts of Yarvis this user has configured: the database, each chat provider, and the integrations (GitHub, Azure DevOps, JIRA, Google Calendar, Hugging Face voice, Telegram). Use it to tell the user what is already done and what they still need.",
      inputSchema: z.object({}),
      execute: async () => {
        const { secrets } = config;
        const providers = await availableProviders(config, "chat");
        return {
          database: isSet(config.databaseUrl),
          chatProviders: providers.map((p) => ({
            id: p.id,
            label: p.label,
            configured: p.available,
            ...(p.id === "bedrock" ? { note: "uses AWS credentials; not checked" } : {}),
          })),
          github: isSet(secrets.githubToken),
          azureDevops: isSet(secrets.azureDevopsToken) && isSet(secrets.azureDevopsOrgUrl),
          jira:
            isSet(secrets.jiraApiToken) && isSet(secrets.jiraBaseUrl) && isSet(secrets.jiraEmail),
          googleCalendarClient: isSet(secrets.googleClientId) && isSet(secrets.googleClientSecret),
          huggingFace: isSet(secrets.huggingFaceApiKey),
          telegram: isSet(config.telegram.botToken),
        };
      },
    }),
  };
}
