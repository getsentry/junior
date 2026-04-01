import { Hono } from "hono";
import { logException } from "@/chat/logging";
import { setPluginPackages } from "@/chat/plugins/package-discovery";
import { GET as diagnosticsGET } from "@/handlers/diagnostics";
import { GET as healthGET } from "@/handlers/health";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { POST as webhooksPOST } from "@/handlers/webhooks";
import type { WaitUntilFn } from "@/handlers/types";

export interface JuniorAppOptions {
  pluginPackages?: string[];
  waitUntil?: WaitUntilFn;
}

/** Build a `WaitUntilFn`, preferring Vercel's lifetime extension when available. */
async function defaultWaitUntil(): Promise<WaitUntilFn> {
  try {
    const { waitUntil } = await import("@vercel/functions");
    return (task) => {
      const promise = typeof task === "function" ? task() : task;
      waitUntil(promise);
    };
  } catch {
    // Outside Vercel (e.g. local dev via node-server), fire-and-forget.
    return (task) => {
      const promise = typeof task === "function" ? task() : task;
      promise.catch(console.error);
    };
  }
}

/** Create a Hono app with all Junior routes mounted under `/api`. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  setPluginPackages(options?.pluginPackages);

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());

  const app = new Hono().basePath("/api");

  app.onError((err, c) => {
    logException(err, "unhandled_route_error");
    return c.text("Internal Server Error", 500);
  });

  app.get("/health", () => healthGET());
  if (process.env.JUNIOR_ENABLE_DIAGNOSTICS === "1") {
    app.get("/__junior/discovery", () => diagnosticsGET());
  }

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
