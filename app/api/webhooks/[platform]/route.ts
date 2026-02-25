import { after } from "next/server";
import { bot } from "@/chat/bot";

type Platform = keyof typeof bot.webhooks;

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/webhooks/[platform]">): Promise<Response> {
  const { platform } = await context.params;
  const handler = bot.webhooks[platform as Platform];

  if (!handler) {
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }

  return handler(request, {
    waitUntil: (task) => after(() => task)
  });
}
