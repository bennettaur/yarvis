import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import type { LanguageModelObject } from "./providers.ts";

/**
 * Fixes for gateways that speak the OpenAI Responses API loosely, LiteLLM
 * chief among them. Each one is a gap between what the gateway sends and what
 * `@ai-sdk/openai` validates, so the fix belongs at that boundary rather than
 * at every caller.
 */

type Fetch = typeof globalThis.fetch;

/**
 * `response` with a new body. `text()` has already decompressed the original,
 * and the new one may be re-serialized, so its length and encoding headers no
 * longer describe it.
 */
function withBody(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Adds `summary: []` to reasoning output items that lack one.
 *
 * The spec requires the field, and the SDK's schema for a non-streamed reply
 * rejects an item without it. LiteLLM omits it when it translates a
 * non-OpenAI model's thinking (a Bedrock Claude, say), which fails the whole
 * call with "Invalid JSON response" even though the answer arrived intact.
 * Streamed replies are left alone: their item schema doesn't ask for it.
 */
export async function fillMissingReasoningSummaries(response: Response): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return withBody(response, text);
  }
  const output = (parsed as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return withBody(response, text);

  let changed = false;
  for (const item of output as ({ type?: unknown; summary?: unknown } | null)[]) {
    if (item?.type === "reasoning" && !Array.isArray(item.summary)) {
      item.summary = [];
      changed = true;
    }
  }
  return withBody(response, changed ? JSON.stringify(parsed) : text);
}

/** A `fetch` for the OpenAI provider that runs every reply through `fillMissingReasoningSummaries`. */
export function responsesCompatFetch(inner: Fetch = globalThis.fetch): Fetch {
  const wrapped = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) =>
    fillMissingReasoningSummaries(await inner(input, init));
  // Bun's `typeof fetch` carries `preconnect`, so the wrapper needs it to type-check as one.
  return Object.assign(wrapped, { preconnect: inner.preconnect }) as Fetch;
}

/**
 * Sends `store: false` on every call, so later steps of a tool loop replay the
 * model's reasoning inline instead of by id.
 *
 * With the SDK's default of `store: true`, earlier reasoning goes back as an
 * `item_reference`. LiteLLM's bridge to a non-OpenAI model has nothing to
 * resolve that id against and drops the item, which loses the signed thinking
 * block a Claude model needs to continue a tool call. Inline, the item carries
 * that block in `encrypted_content`, which LiteLLM decodes back into thinking.
 *
 * OpenAI itself only returns `encrypted_content` when asked, and the SDK asks
 * only for model ids it recognizes as reasoning models. `includeReasoning`
 * asks for a model the catalogue tags `reasoning` behind an alias the SDK
 * doesn't know; without it, a later step would name reasoning OpenAI never
 * stored. It isn't sent for every model because OpenAI rejects it on a
 * non-reasoning one.
 */
export function withoutServerSideStorage(
  model: LanguageModelObject,
  { includeReasoning }: { includeReasoning: boolean },
): LanguageModelObject {
  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          openai: includeReasoning
            ? { store: false, include: ["reasoning.encrypted_content"] }
            : { store: false },
        },
      },
    }),
  });
}
