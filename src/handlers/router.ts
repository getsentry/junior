import { GET as healthGET } from "./health";
import { POST as webhooksPOST } from "./webhooks";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const route = path.join("/");

  if (route === "api/health") {
    return healthGET();
  }

  return new Response("Not Found", { status: 404 });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const route = path.join("/");

  const webhookMatch = route.match(/^api\/webhooks\/(.+)$/);
  if (webhookMatch) {
    const platform = webhookMatch[1];
    return webhooksPOST(request, {
      params: Promise.resolve({ platform })
    });
  }

  return new Response("Not Found", { status: 404 });
}
