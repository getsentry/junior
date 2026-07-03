import { logException } from "@/chat/logging";
import { runAgentDispatchSlice } from "@/chat/agent-dispatch/runner";
import { verifyDispatchCallbackRequest } from "@/chat/agent-dispatch/signing";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { WaitUntilFn } from "@/handlers/types";

interface AgentDispatchHandlerOptions {
  agentRunner: AgentRunner;
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
    runAgentDispatchSlice(payload, {
      agentRunner: options.agentRunner,
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
