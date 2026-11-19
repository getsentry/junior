import { runRetentionPurge } from "@/chat/conversations/retention";
import {
  getAttachmentStorage,
  type AttachmentStorage,
} from "@/chat/attachments/storage";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import { verifySchedulerRequest } from "@/handlers/scheduler-auth";
import { pruneHourlyStats } from "@/stats";

/**
 * Handle the authenticated internal retention cron. One request runs a single
 * bounded purge batch, deletes old hourly counters, and returns the purge
 * counts. Failures are contained here so retention can never affect task
 * execution, heartbeat recovery, or delivery.
 */
export async function GET(
  request: Request,
  options: { attachmentStorage?: AttachmentStorage } = {},
): Promise<Response> {
  if (!verifySchedulerRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const nowMs = Date.now();
    const result = await runRetentionPurge(getSqlExecutor(), {
      attachmentStorage: options.attachmentStorage ?? getAttachmentStorage(),
      nowMs,
    });
    await pruneHourlyStats(nowMs);
    return Response.json(result, { status: 200 });
  } catch (error) {
    logException(error, "retention.run.failed");
    return new Response("Retention purge failed", { status: 500 });
  }
}
