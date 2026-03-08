import { GET as healthGET } from "@/handlers/health";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { POST as queueCallbackPOST } from "@/handlers/queue-callback";
import { POST as webhooksPOST } from "@/handlers/webhooks";

type RouteContext = {
  params: Promise<unknown>;
};

function normalizeRoutePath(pathParts: string[]): string {
  const route = pathParts.join("/").replace(/^\/+|\/+$/g, "");
  return route.startsWith("api/") ? route.slice("api/".length) : route;
}

function getRoutePathParts(params: unknown): string[] {
  if (!params || typeof params !== "object" || !("path" in params)) {
    return [];
  }

  const candidate = (params as { path?: unknown }).path;
  if (!Array.isArray(candidate) || candidate.some((segment) => typeof segment !== "string")) {
    return [];
  }

  return candidate as string[];
}

/**
 * Handles all GET requests routed through `@sentry/junior/handler`.
 *
 * Supported routes:
 * - `api/health`
 * - `api/oauth/callback/:provider`
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const route = normalizeRoutePath(getRoutePathParts(await context.params));

  if (route === "health") {
    return healthGET();
  }

  const oauthCallbackMatch = route.match(/^oauth\/callback\/([^/]+)$/);
  if (oauthCallbackMatch) {
    const provider = oauthCallbackMatch[1];
    return oauthCallbackGET(request, {
      params: Promise.resolve({ provider })
    });
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * Handles all POST requests routed through `@sentry/junior/handler`.
 *
 * Supported routes:
 * - `api/webhooks/:platform`
 * - `api/queue/callback`
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const route = normalizeRoutePath(getRoutePathParts(await context.params));

  if (route === "queue/callback") {
    return queueCallbackPOST(request);
  }

  const webhookMatch = route.match(/^webhooks\/([^/]+)$/);
  if (webhookMatch) {
    const platform = webhookMatch[1];
    return webhooksPOST(request, {
      params: Promise.resolve({ platform })
    });
  }

  return new Response("Not Found", { status: 404 });
}
