import { waitUntilCallbacks, testWaitUntil } from "./callback-after-harness";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";

type OAuthCallbackHandler = typeof import("@/handlers/oauth-callback").GET;

export interface RunOauthCallbackRequestArgs {
  generateReply?: ResumeReplyGenerator;
  handler?: OAuthCallbackHandler;
  provider: string;
  request: Request;
}

/** Runs the generic OAuth callback handler and flushes deferred callback work. */
export async function runOauthCallbackRequest(
  args: RunOauthCallbackRequestArgs,
) {
  waitUntilCallbacks.length = 0;
  const GET = args.handler ?? (await import("@/handlers/oauth-callback")).GET;
  const response = await GET(args.request, args.provider, testWaitUntil, {
    generateReply: args.generateReply,
  });
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

/** Runs the generic OAuth callback route with encoded state and code values. */
export async function runOauthCallbackRoute(args: {
  provider: string;
  state: string;
  code: string;
  generateReply?: ResumeReplyGenerator;
  handler?: OAuthCallbackHandler;
}) {
  return await runOauthCallbackRequest({
    provider: args.provider,
    request: new Request(
      `https://junior.example.com/api/oauth/callback/${args.provider}?state=${encodeURIComponent(args.state)}&code=${encodeURIComponent(args.code)}`,
      { method: "GET" },
    ),
    generateReply: args.generateReply,
    handler: args.handler,
  });
}
