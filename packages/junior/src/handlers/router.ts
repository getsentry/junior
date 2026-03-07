import { GET as healthGET } from "@/handlers/health";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { POST as webhooksPOST } from "@/handlers/webhooks";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

function normalizeRoutePath(pathParts: string[]): string {
  const route = pathParts.join("/").replace(/^\/+|\/+$/g, "");
  return route.startsWith("api/") ? route.slice("api/".length) : route;
}

/**
 * Handles all GET requests routed through `@sentry/junior/handler`.
 *
 * Supported routes:
 * - `api/health`
 * - `api/oauth/callback/:provider`
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const route = normalizeRoutePath(path);

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
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const route = normalizeRoutePath(path);

  const webhookMatch = route.match(/^webhooks\/([^/]+)$/);
  if (webhookMatch) {
    const platform = webhookMatch[1];
    return webhooksPOST(request, {
      params: Promise.resolve({ platform })
    });
  }

  return new Response("Not Found", { status: 404 });
}
