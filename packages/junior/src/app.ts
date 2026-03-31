import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { GET as healthGET } from "@/handlers/health";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { POST as webhooksPOST } from "@/handlers/webhooks";
import type { WaitUntilFn } from "@/handlers/types";

export interface JuniorAppOptions {
  pluginPackages?: string[];
}

/** Build a `WaitUntilFn` that extends the Vercel function lifetime for background work. */
function makeWaitUntil(): WaitUntilFn {
  return (task) => {
    const promise = typeof task === "function" ? task() : task;
    waitUntil(promise);
  };
}

/** Create a Hono app with all Junior routes mounted under `/api`. */
export function createApp(options?: JuniorAppOptions): Hono {
  if (options?.pluginPackages) {
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(options.pluginPackages);
  }

  const app = new Hono().basePath("/api");

  app.get("/health", () => healthGET());

  app.get("/oauth/callback/mcp/:provider", (c) => {
    return mcpOauthCallbackGET(
      c.req.raw,
      c.req.param("provider"),
      makeWaitUntil(),
    );
  });

  app.get("/oauth/callback/:provider", (c) => {
    return oauthCallbackGET(
      c.req.raw,
      c.req.param("provider"),
      makeWaitUntil(),
    );
  });

  app.post("/webhooks/:platform", (c) => {
    return webhooksPOST(c.req.raw, c.req.param("platform"), makeWaitUntil());
  });

  return app;
}
