import { after } from "next/server";
import { bot } from "@/chat/bot";

type Params = { platform: string };

function getPlatform(params: Params | Promise<Params>): Promise<string> {
  if (typeof (params as Promise<Params>).then === "function") {
    return (params as Promise<Params>).then((value) => value.platform);
  }

  return Promise.resolve((params as Params).platform);
}

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Params | Promise<Params> }): Promise<Response> {
  const platform = await getPlatform(context.params);
  const handler = bot.webhooks[platform as keyof typeof bot.webhooks];

  if (!handler) {
    return new Response(`Unknown platform: ${platform}`, { status: 404 });
  }

  return handler(request, {
    waitUntil: (task) => after(() => task)
  });
}
