import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import type { AppEventPublisher } from "@/chat/plugins/agent-hooks";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";
import type { ShowReviewItem } from "@/chat/review-items/changes";
import { verifySchedulerRequest } from "@/handlers/scheduler-auth";
import type { WaitUntilFn } from "@/handlers/types";

export interface HeartbeatHandlerOptions {
  conversationWorkQueue?: ConversationWorkQueue;
  events?: AppEventPublisher;
  showReviewItem?: ShowReviewItem;
}

/** Handle the authenticated internal heartbeat. */
export async function GET(
  request: Request,
  waitUntil: WaitUntilFn,
  options: HeartbeatHandlerOptions = {},
): Promise<Response> {
  if (!verifySchedulerRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const nowMs = Date.now();
  waitUntil(() =>
    runHeartbeat({
      conversationWorkQueue: options.conversationWorkQueue,
      events: options.events,
      nowMs,
      showReviewItem: options.showReviewItem,
    }).catch((error) => {
      logException(error, "heartbeat.failed", {
        "app.heartbeat.now_ms": nowMs,
      });
    }),
  );

  return new Response("Accepted", { status: 202 });
}
