/**
 * Internal timeout-resume handler.
 *
 * This route remains for signed callbacks that were already in flight during a
 * deployment rollover. New timeout continuations are delivered through the
 * durable conversation queue.
 */
import { logException } from "@/chat/logging";
import { resumeTimedOutTurnWithLockRetry } from "@/chat/runtime/timeout-resume-runner";
import { verifyTurnTimeoutResumeRequest } from "@/chat/services/timeout-resume";
import type { WaitUntilFn } from "@/handlers/types";

/** Handle an authenticated internal timeout-resume callback. */
export async function POST(
  request: Request,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  const payload = await verifyTurnTimeoutResumeRequest(request);
  if (!payload) {
    return new Response("Unauthorized", { status: 401 });
  }

  waitUntil(() =>
    resumeTimedOutTurnWithLockRetry(payload).catch((error) => {
      logException(
        error,
        "timeout_resume_handler_failed",
        {},
        {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
        },
        "Timeout resume handler failed",
      );
    }),
  );
  return new Response("Accepted", { status: 202 });
}
