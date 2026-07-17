import { logException } from "@/chat/logging";
import { processAgentDispatchCallback } from "@/chat/agent-dispatch/runner";
import { verifyDispatchCallbackRequest } from "@/chat/agent-dispatch/signing";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { WaitUntilFn } from "@/handlers/types";
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import type { RecoverableSlackDelivery } from "@/chat/slack/recoverable-delivery";

interface AgentDispatchHandlerOptions {
  agentRunner: AgentRunner;
  recoverableSlackDelivery: RecoverableSlackDelivery;
  turnLifecycle: ConversationTurnLifecycle;
}

/** Handle the authenticated internal agent-dispatch callback. */
export async function POST(
  request: Request,
  waitUntil: WaitUntilFn,
  options: AgentDispatchHandlerOptions,
): Promise<Response> {
  const payload = await verifyDispatchCallbackRequest(request);
  if (!payload) {
    return new Response("Unauthorized", { status: 401 });
  }

  waitUntil(() =>
    processAgentDispatchCallback(payload, {
      agentRunner: options.agentRunner,
      recoverableSlackDelivery: options.recoverableSlackDelivery,
      turnLifecycle: options.turnLifecycle,
    }).catch((error) => {
      logException(
        error,
        "agent_dispatch_handler_failed",
        {},
        { "app.dispatch.id": payload.id },
        "Agent dispatch handler failed",
      );
    }),
  );
  return new Response("Accepted", { status: 202 });
}
