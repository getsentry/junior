import { after } from "next/server";
import { bot } from "@/chat/bot";
import { captureException, withSpan } from "@/chat/observability";

type Platform = keyof typeof bot.webhooks;

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/webhooks/[platform]">): Promise<Response> {
  const { platform } = await context.params;
  const handler = bot.webhooks[platform as Platform];
  const requestId = request.headers.get("x-request-id") ?? undefined;

  if (!handler) {
    captureException(new Error(`Unknown platform: ${platform}`), {
      platform,
      requestId
    });
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }

  try {
    return await withSpan(
      "webhook.handle",
      "webhook.handle",
      {
        platform,
        requestId
      },
      () =>
        handler(request, {
          waitUntil: (task) => after(() => task)
        })
    );
  } catch (error) {
    captureException(error, {
      platform,
      requestId
    });
    throw error;
  }
}
