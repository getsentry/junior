import { Hono } from "hono";
import { logException } from "@/chat/logging";
import { GET as healthGET } from "@/handlers/health";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { POST as webhooksPOST } from "@/handlers/webhooks";
import type { WaitUntilFn } from "@/handlers/types";

export interface JuniorAppOptions {
  pluginPackages?: string[];
  waitUntil?: WaitUntilFn;
}

/** Build a `WaitUntilFn` backed by the Vercel function lifetime extension. */
async function defaultWaitUntil(): Promise<WaitUntilFn> {
  const { waitUntil } = await import("@vercel/functions");
  return (task) => {
    const promise = typeof task === "function" ? task() : task;
    waitUntil(promise);
  };
}

/** Create a Hono app with all Junior routes mounted under `/api`. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  // TODO: thread plugin config through properly instead of global env mutation.
  if (options?.pluginPackages) {
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(options.pluginPackages);
  }

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());

  const app = new Hono().basePath("/api");

  // Sentry's honoIntegration captures exceptions automatically; this handler
  // adds structured logging and returns a clean 500 without double-reporting.
  app.onError((err, c) => {
    logException(err, "unhandled_route_error");
    return c.text("Internal Server Error", 500);
  });

  app.get("/health", () => healthGET());

  // MCP callback must be registered before the generic OAuth callback
  // because Hono matches routes top-down and `:provider` would swallow `mcp/`.
  app.get("/oauth/callback/mcp/:provider", (c) => {
    return mcpOauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil);
  });

  app.get("/oauth/callback/:provider", (c) => {
    return oauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil);
  });

  app.post("/webhooks/:platform", (c) => {
    return webhooksPOST(c.req.raw, c.req.param("platform"), waitUntil);
  });

  return app;
}
