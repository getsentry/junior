import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  waitUntilCallbacks,
  testWaitUntil,
} from "./oauth-callback-after-harness";
import { realAgentRunner } from "./agent-runner";

export async function runMcpOauthCallbackRoute(args: {
  provider: string;
  state: string;
  code: string;
  agentRunner?: AgentRunner;
  conversationWorkQueue?: ConversationWorkQueue;
  expectBackgroundWork?: boolean;
  relayed?: boolean;
}) {
  waitUntilCallbacks.length = 0;
  const { GET } = await import("@/handlers/mcp-oauth-callback");
  const response = await GET(
    new Request(
      `https://junior.example.com/api/oauth/callback/mcp/${args.provider}?state=${encodeURIComponent(args.state)}&code=${encodeURIComponent(args.code)}${args.relayed ? "&jr_local_relay=complete" : ""}`,
      { method: "GET" },
    ),
    args.provider,
    testWaitUntil,
    {
      agentRunner: args.agentRunner ?? realAgentRunner,
      ...(args.conversationWorkQueue
        ? { conversationWorkQueue: args.conversationWorkQueue }
        : {}),
    },
  );
  const callbacks = waitUntilCallbacks.splice(0, waitUntilCallbacks.length);
  if (args.expectBackgroundWork === false && callbacks.length > 0) {
    throw new Error(
      `MCP OAuth callback route registered unexpected waitUntil() work for provider "${args.provider}"`,
    );
  }
  for (const callback of callbacks) {
    await callback();
  }
  if (
    response.status === 200 &&
    callbacks.length === 0 &&
    args.expectBackgroundWork !== false
  ) {
    throw new Error(
      `MCP OAuth callback route returned 200 without registering waitUntil() work for provider "${args.provider}"`,
    );
  }
  return response;
}

/** Complete the headless authorization transition and run its callback route. */
export async function completeMcpOauthCallbackRoute(args: {
  provider: string;
  authSessionId: string;
  agentRunner?: AgentRunner;
  conversationWorkQueue?: ConversationWorkQueue;
  expectBackgroundWork?: boolean;
  relayed?: boolean;
}) {
  const { getMcpAuthSession } = await import("@/chat/mcp/auth-store");
  const session = await getMcpAuthSession(args.authSessionId);
  if (!session?.authorizationUrl) {
    throw new Error(`Missing MCP authorization URL: ${args.authSessionId}`);
  }
  const authorization = await fetch(session.authorizationUrl, {
    redirect: "manual",
  });
  const location = authorization.headers.get("location");
  if (authorization.status !== 302 || !location) {
    throw new Error(`MCP authorization failed: ${authorization.status}`);
  }
  const callback = new URL(location);
  const state = callback.searchParams.get("state");
  const code = callback.searchParams.get("code");
  if (!state || !code) {
    throw new Error("MCP authorization callback omitted code or state");
  }
  return await runMcpOauthCallbackRoute({
    provider: args.provider,
    state,
    code,
    ...(args.agentRunner ? { agentRunner: args.agentRunner } : {}),
    ...(args.conversationWorkQueue
      ? { conversationWorkQueue: args.conversationWorkQueue }
      : {}),
    ...(args.expectBackgroundWork === false
      ? { expectBackgroundWork: false }
      : {}),
    ...(args.relayed ? { relayed: true } : {}),
  });
}
