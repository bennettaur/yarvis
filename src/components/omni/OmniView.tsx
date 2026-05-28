import {
  applySpecPatch,
  buildUserPrompt,
  createMixedStreamParser,
  type Spec,
} from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listProviders, type ProviderId, type ProviderInfo } from "../../lib/chat";
import {
  deleteLayout,
  getLayout,
  listLayouts,
  type OmniLayoutSummary,
  saveLayout,
  streamOmni,
} from "../../lib/omni";
import { catalog } from "../../omni/catalog";
import { registry } from "../../omni/registry";
import ChatComposer from "../ChatComposer";

interface Display {
  role: "user" | "assistant";
  content: string;
}

const PROVIDER_KEY = "yarvis.chat.provider";
const MODEL_KEY = "yarvis.chat.model";
// The last built layout + conversation persist so navigating away and back
// (which unmounts this view) restores what you had.
const SPEC_KEY = "yarvis.omni.spec";
const MESSAGES_KEY = "yarvis.omni.messages";
const BUILDER_COLLAPSED_KEY = "yarvis.omni.builderCollapsed";
// Cap how many prior turns are replayed to the model per request.
const MAX_HISTORY_MESSAGES = 12;

const EXAMPLES = [
  "Show my tasks and calendar side by side, with a chat underneath",
  "Give me a dashboard of my PRs, tasks, and memory",
  "Just a big chat window next to my tasks",
];

function hasContent(spec: Spec | null): boolean {
  return !!spec && !!spec.root && Object.keys(spec.elements ?? {}).length > 0;
}

function loadSpec(): Spec | null {
  try {
    const raw = localStorage.getItem(SPEC_KEY);
    const parsed = raw ? (JSON.parse(raw) as Spec) : null;
    return hasContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadMessages(): Display[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    return raw ? (JSON.parse(raw) as Display[]) : [];
  } catch {
    return [];
  }
}

function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400" />
  );
}

export default function OmniView() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [model, setModel] = useState("");
  const [spec, setSpec] = useState<Spec | null>(loadSpec);
  const [messages, setMessages] = useState<Display[]>(loadMessages);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layouts, setLayouts] = useState<OmniLayoutSummary[]>([]);
  const [layoutName, setLayoutName] = useState("");
  const [loadedId, setLoadedId] = useState("");
  const [builderCollapsed, setBuilderCollapsed] = useState<boolean>(
    () => localStorage.getItem(BUILDER_COLLAPSED_KEY) === "1",
  );
  const threadRef = useRef<HTMLDivElement>(null);

  // The catalog defines what the agent may compose; turn it into a system
  // prompt once. `inline` mode = converse first, then emit JSONL spec patches.
  const system = useMemo(() => catalog.prompt({ mode: "inline", editModes: ["patch"] }), []);

  useEffect(() => {
    void (async () => {
      try {
        const provs = await listProviders();
        setProviders(provs);
        const savedProvider = localStorage.getItem(PROVIDER_KEY) as ProviderId | null;
        const savedModel = localStorage.getItem(MODEL_KEY);
        const chosen =
          provs.find((p) => p.id === savedProvider) ?? provs.find((p) => p.available) ?? provs[0];
        if (chosen) {
          setProvider(chosen.id);
          setModel(
            savedModel && chosen.models.includes(savedModel)
              ? savedModel
              : (chosen.models[0] ?? ""),
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (provider) localStorage.setItem(PROVIDER_KEY, provider);
    if (model) localStorage.setItem(MODEL_KEY, model);
  }, [provider, model]);

  useEffect(() => {
    localStorage.setItem(BUILDER_COLLAPSED_KEY, builderCollapsed ? "1" : "0");
  }, [builderCollapsed]);

  // Persist the rendered layout and conversation across navigation/restarts.
  useEffect(() => {
    if (hasContent(spec)) localStorage.setItem(SPEC_KEY, JSON.stringify(spec));
    else localStorage.removeItem(SPEC_KEY);
  }, [spec]);

  useEffect(() => {
    if (messages.length) localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
    else localStorage.removeItem(MESSAGES_KEY);
  }, [messages]);

  useEffect(() => {
    threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
  }, []);

  const refreshLayouts = useCallback(async () => {
    try {
      setLayouts(await listLayouts());
    } catch (e) {
      // Layouts need a configured database; absence isn't fatal here.
      console.warn("[omni] could not load saved layouts:", e);
    }
  }, []);

  useEffect(() => {
    void refreshLayouts();
  }, [refreshLayouts]);

  const modelsFor = useCallback(
    (id: ProviderId) => providers.find((p) => p.id === id)?.models ?? [],
    [providers],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !provider || !model || busy) return;

      const priorHistory = messages;
      setInput("");
      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setBusy(true);
      setError(null);

      // Patches apply to a working copy of the current spec, so follow-up
      // requests ("add a chat underneath") edit the existing layout.
      const working: Spec = hasContent(spec)
        ? structuredClone(spec as Spec)
        : { root: "", elements: {} };
      let prose = "";
      let _patchCount = 0;
      let appliedCount = 0;
      const parser = createMixedStreamParser({
        onText: (t) => {
          prose += t;
          setStreaming(prose);
        },
        onPatch: (patch) => {
          _patchCount += 1;
          try {
            applySpecPatch(working, patch);
            appliedCount += 1;
            setSpec({ ...working });
          } catch (err) {
            // A patch can fail if it references a not-yet-created path; log so
            // the failure is visible rather than silently dropping the layout.
            console.warn("[omni] failed to apply patch", patch, err);
          }
        },
      });

      // The current spec is embedded in the final user turn so the model can
      // patch it; prior turns carry conversational context.
      const userPrompt = buildUserPrompt({
        prompt: trimmed,
        currentSpec: hasContent(spec) ? spec : null,
        editModes: ["patch"],
      });
      // The current spec is embedded in the final turn, so older turns add
      // little; cap replayed history to keep the request bounded over a long
      // session.
      const outMessages = [
        ...priorHistory
          .slice(-MAX_HISTORY_MESSAGES)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: userPrompt },
      ];

      let failureMessage: string | null = null;
      try {
        for await (const evt of streamOmni({
          system,
          messages: outMessages,
          provider,
          model,
        })) {
          if (evt.type === "delta" && evt.text) {
            parser.push(evt.text);
          } else if (evt.type === "error") {
            failureMessage = evt.message ?? "generation error";
            console.error("[omni] generation error:", failureMessage);
          }
        }
        parser.flush();
      } catch (e) {
        failureMessage = e instanceof Error ? e.message : String(e);
        console.error("[omni] request failed:", e);
      } finally {
        if (prose.trim()) {
          setMessages((prev) => [...prev, { role: "assistant", content: prose.trim() }]);
        }
        // Surface the case where the request "succeeded" but produced nothing
        // usable — otherwise the chat just re-enables with no feedback.
        if (!failureMessage && !prose.trim() && appliedCount === 0) {
          failureMessage =
            "The model returned no usable output. Check the selected model name and provider key (see console/sidecar logs).";
        }
        setError(failureMessage);
        setStreaming("");
        setBusy(false);
      }
    },
    [provider, model, busy, messages, spec, system],
  );

  const reset = useCallback(() => {
    setSpec(null);
    setMessages([]);
    setStreaming("");
    setError(null);
    setLoadedId("");
  }, []);

  const onSave = useCallback(async () => {
    const name = layoutName.trim();
    if (!name || !hasContent(spec) || busy) return;
    try {
      const saved = await saveLayout(name, spec as Spec);
      setLayoutName("");
      setLoadedId(saved.id);
      setError(null);
      await refreshLayouts();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[omni] save layout failed:", e);
      setError(`Could not save layout: ${message}`);
    }
  }, [layoutName, spec, busy, refreshLayouts]);

  const onLoad = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const layout = await getLayout(id);
      setSpec(layout.spec);
      setMessages([]);
      setStreaming("");
      setError(null);
      setLoadedId(id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[omni] load layout failed:", e);
      setError(`Could not load layout: ${message}`);
    }
  }, []);

  const onDelete = useCallback(async () => {
    if (!loadedId) return;
    try {
      await deleteLayout(loadedId);
      setLoadedId("");
      await refreshLayouts();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[omni] delete layout failed:", e);
      setError(`Could not delete layout: ${message}`);
    }
  }, [loadedId, refreshLayouts]);

  return (
    <div className="flex h-full min-h-0">
      {/* Canvas */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          className={`h-0.5 shrink-0 ${busy ? "animate-pulse bg-indigo-500" : "bg-transparent"}`}
          aria-hidden="true"
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {hasContent(spec) ? (
            <div className="min-h-full">
              <JSONUIProvider registry={registry}>
                <Renderer spec={spec} registry={registry} loading={busy} />
              </JSONUIProvider>
            </div>
          ) : busy ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-400">
              <Spinner />
              Generating your layout…
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
              <div>
                <h2 className="text-lg font-semibold text-zinc-200">Omni</h2>
                <p className="mt-1 max-w-md text-sm text-zinc-500">
                  Ask the chat to build a view from your widgets — tasks, calendar, PRs, memory,
                  sessions, alarms, and chat windows — in any layout.
                </p>
              </div>
              <div className="flex max-w-md flex-col gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => void send(ex)}
                    disabled={busy || !provider || !model}
                    className="border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 disabled:opacity-40"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Builder side panel — collapsible to give the canvas full width */}
      {builderCollapsed ? (
        <aside className="flex w-9 shrink-0 flex-col items-center gap-3 border-l border-zinc-800 py-2">
          <button
            onClick={() => setBuilderCollapsed(false)}
            title="Expand builder"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ‹
          </button>
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 [writing-mode:vertical-rl]">
            Builder
          </span>
        </aside>
      ) : (
        <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setBuilderCollapsed(true)}
                title="Collapse builder"
                className="text-zinc-500 hover:text-zinc-300"
              >
                ›
              </button>
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Builder
              </span>
            </div>
            <button onClick={reset} className="text-xs text-zinc-500 hover:text-zinc-300">
              Clear
            </button>
          </div>

          <div className="flex flex-wrap gap-2 border-b border-zinc-800 px-4 py-2">
            <select
              value={provider}
              onChange={(e) => {
                const id = e.target.value as ProviderId;
                setProvider(id);
                setModel(modelsFor(id)[0] ?? "");
              }}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}
                  {p.available ? "" : " (no key)"}
                </option>
              ))}
            </select>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
            >
              {(provider ? modelsFor(provider) : []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* Saved layouts */}
          <div className="space-y-2 border-b border-zinc-800 px-4 py-2">
            <div className="flex gap-2">
              <select
                value={loadedId}
                onChange={(e) => void onLoad(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
              >
                <option value="">— load layout —</option>
                {layouts.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void onDelete()}
                disabled={!loadedId}
                title="Delete the selected layout"
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-40"
              >
                Delete
              </button>
            </div>
            <div className="flex gap-2">
              <input
                value={layoutName}
                placeholder="Save current layout as…"
                disabled={!hasContent(spec)}
                onChange={(e) => setLayoutName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onSave();
                }}
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none focus:border-zinc-500 disabled:opacity-40"
              />
              <button
                onClick={() => void onSave()}
                disabled={!hasContent(spec) || !layoutName.trim()}
                className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>

          <div ref={threadRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.length === 0 && !streaming && (
              <p className="text-sm text-zinc-600">
                Describe the layout you want. Follow-ups refine the current view.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className="text-sm">
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{m.role}</div>
                <div className="whitespace-pre-wrap text-zinc-100">{m.content}</div>
              </div>
            ))}
            {streaming && (
              <div className="text-sm">
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">assistant</div>
                <div className="whitespace-pre-wrap text-zinc-100">{streaming}</div>
              </div>
            )}
            {busy && !streaming && (
              <div className="text-sm">
                <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">assistant</div>
                <div className="flex items-center gap-2 text-zinc-400">
                  <Spinner />
                  Thinking…
                </div>
              </div>
            )}
          </div>

          {error && <p className="px-4 pb-2 text-sm text-red-400">{error}</p>}

          <ChatComposer
            value={input}
            onChange={setInput}
            onSubmit={() => void send(input)}
            busy={busy}
            placeholder="Describe a layout..."
            submitLabel="Build"
            className="flex gap-2 border-t border-zinc-800 p-3"
          />
        </aside>
      )}
    </div>
  );
}
