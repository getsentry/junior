import { GET as healthGET } from "@/handlers/health";
import { POST as webhooksPOST } from "@/handlers/webhooks";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

function normalizeRoutePath(pathParts: string[]): string {
  const route = pathParts.join("/").replace(/^\/+|\/+$/g, "");
  return route.startsWith("api/") ? route.slice("api/".length) : route;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const route = normalizeRoutePath(path);

  if (route === "health") {
    return healthGET();
  }

  return new Response("Not Found", { status: 404 });
}

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
