import { verifyCronRequest } from "@/handlers/cron-auth";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";
import type { WaitUntilFn } from "@/handlers/types";

export interface HeartbeatHandlerOptions {
  conversationWorkQueue?: ConversationWorkQueue;
}

/** Handle the authenticated internal heartbeat. */
export async function GET(
  request: Request,
  waitUntil: WaitUntilFn,
  options: HeartbeatHandlerOptions = {},
): Promise<Response> {
  if (!verifyCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const nowMs = Date.now();
  waitUntil(() =>
    runHeartbeat({
      conversationWorkQueue: options.conversationWorkQueue,
      nowMs,
    }).catch((error) => {
      logException(error, "heartbeat.failed", {
        "app.heartbeat.now_ms": nowMs,
      });
    }),
  );

  return new Response("Accepted", { status: 202 });
}
