import {
  waitUntilCallbacks,
  testWaitUntil,
} from "./oauth-callback-after-harness";
import type { ResumeReplyGenerator } from "@/chat/runtime/slack-resume";

export interface RunMcpOauthCallbackRequestArgs {
  generateReply?: ResumeReplyGenerator;
  provider: string;
  request: Request;
}

/** Runs the MCP OAuth callback handler and flushes deferred callback work. */
export async function runMcpOauthCallbackRequest(
  args: RunMcpOauthCallbackRequestArgs,
) {
  waitUntilCallbacks.length = 0;
  const { GET } = await import("@/handlers/mcp-oauth-callback");
  const response = await GET(args.request, args.provider, testWaitUntil, {
    generateReply: args.generateReply,
  });
  const callbacks = waitUntilCallbacks.splice(0, waitUntilCallbacks.length);
  for (const callback of callbacks) {
    await callback();
  }
  if (response.status === 200 && callbacks.length === 0) {
    throw new Error(
      `MCP OAuth callback route returned 200 without registering waitUntil() work for provider "${args.provider}"`,
    );
  }
  return response;
}

/** Runs the MCP OAuth callback route with encoded state and code values. */
export async function runMcpOauthCallbackRoute(args: {
  provider: string;
  state: string;
  code: string;
  generateReply?: ResumeReplyGenerator;
}) {
  return await runMcpOauthCallbackRequest({
    provider: args.provider,
    request: new Request(
      `https://junior.example.com/api/oauth/callback/mcp/${args.provider}?state=${encodeURIComponent(args.state)}&code=${encodeURIComponent(args.code)}`,
      { method: "GET" },
    ),
    generateReply: args.generateReply,
  });
}
