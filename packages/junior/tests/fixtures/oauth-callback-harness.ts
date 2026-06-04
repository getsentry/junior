import {
  waitUntilCallbacks,
  testWaitUntil,
} from "./oauth-callback-after-harness";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";

export async function runOauthCallbackRoute(args: {
  provider: string;
  state: string;
  code: string;
  generateReply?: ResumeReplyGenerator;
}) {
  waitUntilCallbacks.length = 0;
  const { GET } = await import("@/handlers/oauth-callback");
  const response = await GET(
    new Request(
      `https://junior.example.com/api/oauth/callback/${args.provider}?state=${encodeURIComponent(args.state)}&code=${encodeURIComponent(args.code)}`,
      { method: "GET" },
    ),
    args.provider,
    testWaitUntil,
    { generateReply: args.generateReply },
  );
  const callbacks = waitUntilCallbacks.splice(0, waitUntilCallbacks.length);
  for (const callback of callbacks) {
    await callback();
  }
  if (response.status === 200 && callbacks.length === 0) {
    throw new Error(
      `OAuth callback route returned 200 without registering waitUntil() work for provider "${args.provider}"`,
    );
  }
  return response;
}
