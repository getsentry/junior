import { verifyDispatchCallbackRequest } from "@/chat/agent-dispatch/signing";
import {
  getDispatchRecord,
  isTerminalDispatchStatus,
} from "@/chat/agent-dispatch/store";
import { enqueueAgentDispatch } from "@/chat/agent-dispatch/work";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";
import type { WaitUntilFn } from "@/handlers/types";

interface AgentDispatchHandlerOptions {
  conversationWorkQueue: ConversationWorkQueue;
}

/**
 * Convert a legacy authenticated dispatch callback into conversation work.
 *
 * TODO(v0.116.0): Remove with the v0.114 callback verification route.
 */
export async function POST(
  request: Request,
  waitUntil: WaitUntilFn,
  options: AgentDispatchHandlerOptions,
): Promise<Response> {
  const payload = await verifyDispatchCallbackRequest(request);
  if (!payload) {
    return new Response("Unauthorized", { status: 401 });
  }

  waitUntil(
    (async () => {
      const dispatch = await getDispatchRecord(payload.id);
      if (!dispatch) {
        throw new Error(`Dispatch record is missing for ${payload.id}`);
      }
      if (isTerminalDispatchStatus(dispatch.status)) {
        return;
      }
      await enqueueAgentDispatch(dispatch, {
        queue: options.conversationWorkQueue,
      });
    })().catch((error) => {
      logException(error, "agent.dispatch.callback.failed", {
        "app.dispatch.id": payload.id,
      });
    }),
  );
  return new Response("Accepted", { status: 202 });
}
