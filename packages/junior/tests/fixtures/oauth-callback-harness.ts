import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { ScheduleAgentContinueOptions } from "@/chat/services/agent-continue";
import { getConversationEventStore } from "@/chat/db";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import {
  waitUntilCallbacks,
  testWaitUntil,
} from "./oauth-callback-after-harness";
import { realAgentRunner } from "./agent-runner";
import { createConversationWorkQueueTestAdapter } from "./conversation-work";

export async function runOauthCallbackRoute(args: {
  provider: string;
  state: string;
  code: string;
  agentRunner?: AgentRunner;
  agentContinueOptions?: ScheduleAgentContinueOptions;
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
    {
      agentRunner: args.agentRunner ?? realAgentRunner,
      ...(args.agentContinueOptions
        ? { agentContinueOptions: args.agentContinueOptions }
        : {
            agentContinueOptions: {
              queue: createConversationWorkQueueTestAdapter(),
            },
          }),
      turnLifecycle: new ConversationTurnLifecycleService(
        getConversationEventStore(),
      ),
    },
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
