import { runRetentionPurge } from "@/chat/conversations/retention";
import {
  getAttachmentStorage,
  type AttachmentStorage,
} from "@/chat/attachments/storage";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import { verifySchedulerRequest } from "@/handlers/scheduler-auth";

/**
 * Handle the authenticated internal retention cron. One request runs a single
 * bounded purge batch and returns its counts. Failures are contained here so
 * retention can never affect task execution, heartbeat recovery, or delivery.
 */
export async function GET(
  request: Request,
  options: { attachmentStorage?: AttachmentStorage } = {},
): Promise<Response> {
  if (!verifySchedulerRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await runRetentionPurge(getSqlExecutor(), {
      attachmentStorage: options.attachmentStorage ?? getAttachmentStorage(),
      nowMs: Date.now(),
    });
    return Response.json(result, { status: 200 });
  } catch (error) {
    logException(error, "retention.run.failed");
    return new Response("Retention purge failed", { status: 500 });
  }
}
