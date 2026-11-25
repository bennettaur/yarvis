import { spyOn } from "bun:test";

/**
 * Answers the page's `fetch` calls to the server from a table of routes keyed
 * `"METHOD /path"`, recording each call. Anything not in the table gets a 404.
 * The returned `restore` puts the real `fetch` back, for the suite's `afterAll`.
 */
export function stubServerRoutes(
  routes: Record<string, (body: unknown) => Response | Promise<Response>>,
): {
  calls: { route: string; body: unknown }[];
  restore: () => void;
} {
  const calls: { route: string; body: unknown }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const route = `${init?.method ?? "GET"} ${String(url)}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const handler = routes[route];
    return handler ? handler(body) : Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch);
  return { calls, restore: () => spy.mockRestore() };
}
