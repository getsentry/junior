import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { vi } from "vitest";
import type { AuthenticatedRoute } from "@/dashboard-routes";
import { resolveViewerUser } from "@/chat/plugins/viewer";

export const MCP_TEST_ORIGIN = "http://junior.test";
export const MCP_TEST_URL = `${MCP_TEST_ORIGIN}/api/mcp`;
/** Cookie that the fake dashboard reads in place of a Google sign-in session. */
const TEST_VIEWER_COOKIE = "junior_test_viewer";

/**
 * Supply a dashboard whose sign-in is faked. Authenticated routes receive the
 * user named by the test viewer cookie, as the real dashboard passes the
 * Google-verified user. Requests without the cookie get 401.
 */
export function mockMcpDashboardConfig(): void {
  vi.doMock("#junior/config", () => ({
    createDashboardApp: (options: {
      authenticatedRoutes?: readonly AuthenticatedRoute[];
    }) => {
      const app = new Hono();
      for (const route of options.authenticatedRoutes ?? []) {
        app.on(["GET", "POST"], route.path, async (c) => {
          const email = c.req
            .header("cookie")
            ?.match(new RegExp(`${TEST_VIEWER_COOKIE}=([^;]+)`))?.[1];
          if (!email) return new Response("Unauthorized", { status: 401 });
          const user = await resolveViewerUser(decodeURIComponent(email));
          if (!user) throw new Error("MCP test viewer could not be resolved");
          return await route.handler(c.req.raw, user);
        });
      }
      return app;
    },
    dashboard: { baseURL: MCP_TEST_ORIGIN },
    functionMaxDurationSeconds: undefined,
    pluginSet: undefined,
    plugins: undefined,
    pluginRuntimeRegistrations: [],
  }));
}

/** Build the cookie header that signs one viewer in to the fake dashboard. */
export function viewerCookie(email: string): string {
  return `${TEST_VIEWER_COOKIE}=${encodeURIComponent(email)}`;
}

/** Run one callback with the official MCP SDK client and an access token. */
export async function withMcpClient<T>(
  app: Hono,
  accessToken: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "junior-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_URL), {
    fetch: async (input, init) => await app.fetch(new Request(input, init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}
