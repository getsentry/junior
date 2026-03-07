import { GET as handlerGET } from "@sentry/junior/handler";

type RouteContext = {
  params: Promise<{
    provider: string;
  }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { provider } = await context.params;
  return handlerGET(request, {
    params: Promise.resolve({
      path: ["oauth", "callback", provider]
    })
  });
}

export const runtime = "nodejs";
