import { createOAuthWork } from "./oauth-work";
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
  const work = createOAuthWork(args.agentRunner ?? realAgentRunner);
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
      conversationWorkQueue: work.queue,
      ...(args.conversationWorkQueue
        ? { conversationWorkQueue: args.conversationWorkQueue }
        : undefined),
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
  if (!args.conversationWorkQueue) await work.drain();
  return response;
}
