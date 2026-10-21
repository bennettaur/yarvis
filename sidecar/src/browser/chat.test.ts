import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { addMessage } from "../chat/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { BrowserBridge } from "./bridge.ts";
import { createBrowserChatRoutes, describeTab } from "./chat.ts";
import { createBrowserRoutes } from "./routes.ts";

const host = { Host: "127.0.0.1:8765" };
const auth = { ...host, Authorization: "Bearer browser-token", "Content-Type": "application/json" };

function setup(databaseUrl?: string) {
  // The routes under test answer before they touch the database, so the URL is never dialled.
  const config = { port: 8765, databaseUrl, secrets: {} } as unknown as Config;
  return createBrowserRoutes(
    config,
    new BrowserBridge("browser-token"),
    createBrowserChatRoutes(config),
  );
}

describe("browser chat routes", () => {
  it("sit behind the bridge's scoped token and host pin", async () => {
    const app = setup("postgres://unused/db");
    expect((await app.request("/chat/sessions", { headers: host })).status).toBe(401);
    const wrongHost = await app.request("/chat/sessions", {
      headers: { ...auth, Host: "evil.example:8765" },
    });
    expect(wrongHost.status).toBe(403);
  });

  it("says so when there is no database", async () => {
    const app = setup(undefined);
    expect((await app.request("/chat/sessions", { headers: auth })).status).toBe(503);
  });

  it("refuses a turn that isn't shaped like one", async () => {
    const app = setup("postgres://unused/db");
    const res = await app.request("/chat", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ sessionId: "not-a-uuid", message: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a session id that isn't a uuid", async () => {
    const app = setup("postgres://unused/db");
    const res = await app.request("/chat/sessions/nope/messages", { headers: auth });
    expect(res.status).toBe(400);
  });
});

describe("describeTab", () => {
  const tab = {
    tabId: 42,
    url: "https://mail.example.com/inbox?token=secret#thread",
    title: "Inbox",
    profile: "work",
  };

  it("names the tab and how to read it with the browser tools", () => {
    const text = describeTab(tab);
    expect(text).toContain('Chrome profile "work"');
    expect(text).toContain("Title: Inbox");
    expect(text).toContain('read_browser_page with tabId 42 and profile "work"');
  });

  it("drops the query and fragment from the URL", () => {
    const text = describeTab(tab);
    expect(text).toContain("URL: https://mail.example.com/inbox\n");
    expect(text).not.toContain("secret");
  });

  it("includes the selected text only when there is some", () => {
    expect(describeTab({ ...tab, selection: "  " })).not.toContain("selected");
    expect(describeTab({ ...tab, selection: "a quote" })).toContain("a quote");
  });
});

describe("browser chat sessions", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const app = setup(url);

  beforeEach(async () => {
    await sql`TRUNCATE chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("creates a session and lists it", async () => {
    const created = await app.request("/chat/sessions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "From Chrome" }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string; title: string };
    expect(session.title).toBe("From Chrome");

    const listed = (await (await app.request("/chat/sessions", { headers: auth })).json()) as {
      id: string;
    }[];
    expect(listed.map((s) => s.id)).toEqual([session.id]);
  });

  it("returns a thread's words without compaction summaries", async () => {
    const created = await app.request("/chat/sessions", { method: "POST", headers: auth });
    const { id } = (await created.json()) as { id: string };
    const { db } = getDb(url);
    await addMessage(db, { sessionId: id, role: "user", content: "hello" });
    await addMessage(db, { sessionId: id, role: "system", content: "a summary" });
    await addMessage(db, { sessionId: id, role: "assistant", content: "hi" });

    const res = await app.request(`/chat/sessions/${id}/messages`, { headers: auth });
    const messages = (await res.json()) as { role: string; content: string }[];
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });
});
