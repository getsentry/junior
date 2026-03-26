import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as healthGET } from "@/handlers/health";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { POST as webhooksPOST } from "@/handlers/webhooks";

type RouteContext = {
  params: Promise<unknown>;
};

/**
 * `@sentry/junior/handler` is a stable public entrypoint for Next.js catch-all routes.
 * Keep this router thin and explicit so app code can export one handler module while
 * runtime internals continue to evolve behind it.
 */
function trimEdgeSlashes(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(start, end);
}

function normalizeRoutePath(pathParts: string[]): string {
  const route = trimEdgeSlashes(pathParts.join("/"));
  return route.startsWith("api/") ? route.slice("api/".length) : route;
}

function getRoutePathParts(params: unknown): string[] {
  if (!params || typeof params !== "object" || !("path" in params)) {
    return [];
  }

  const candidate = (params as { path?: unknown }).path;
  if (
    !Array.isArray(candidate) ||
    candidate.some((segment) => typeof segment !== "string")
  ) {
    return [];
  }

  return candidate as string[];
}

/**
 * Handles all GET requests routed through `@sentry/junior/handler`.
 *
 * Supported routes:
 * - `api/health`
 * - `api/oauth/callback/mcp/:provider`
 * - `api/oauth/callback/:provider`
 */
export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const route = normalizeRoutePath(getRoutePathParts(await context.params));

  if (route === "health") {
    return healthGET();
  }

  const mcpOauthCallbackMatch = route.match(/^oauth\/callback\/mcp\/([^/]+)$/);
  if (mcpOauthCallbackMatch) {
    const provider = mcpOauthCallbackMatch[1];
    return mcpOauthCallbackGET(request, {
      params: Promise.resolve({ provider }),
    });
  }

  const oauthCallbackMatch = route.match(/^oauth\/callback\/([^/]+)$/);
  if (oauthCallbackMatch) {
    const provider = oauthCallbackMatch[1];
    return oauthCallbackGET(request, {
      params: Promise.resolve({ provider }),
    });
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * Handles all POST requests routed through `@sentry/junior/handler`.
 *
 * Supported routes:
 * - `api/webhooks/:platform`
 */
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const route = normalizeRoutePath(getRoutePathParts(await context.params));

  const webhookMatch = route.match(/^webhooks\/([^/]+)$/);
  if (webhookMatch) {
    const platform = webhookMatch[1];
    return webhooksPOST(request, {
      params: Promise.resolve({ platform }),
    });
  }

  return new Response("Not Found", { status: 404 });
}
