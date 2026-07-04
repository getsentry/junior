import type { AgentRunner } from "@/chat/runtime/agent-runner";
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
}) {
  waitUntilCallbacks.length = 0;
  const { GET } = await import("@/handlers/mcp-oauth-callback");
  const response = await GET(
    new Request(
      `https://junior.example.com/api/oauth/callback/mcp/${args.provider}?state=${encodeURIComponent(args.state)}&code=${encodeURIComponent(args.code)}`,
      { method: "GET" },
    ),
    args.provider,
    testWaitUntil,
    { agentRunner: args.agentRunner ?? realAgentRunner },
  );
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
