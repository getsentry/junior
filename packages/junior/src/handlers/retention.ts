import { runRetentionPurge } from "@/chat/conversations/retention";
import {
  getAttachmentStorage,
  type AttachmentStorage,
} from "@/chat/attachments/storage";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import { reportTableSizes } from "@/db/table-size";
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
    const executor = getSqlExecutor();
    const result = await runRetentionPurge(executor, {
      attachmentStorage: options.attachmentStorage ?? getAttachmentStorage(),
      nowMs,
    });
    // Best effort: a failure must not fail the purge response, or the
    // scheduler retries a purge batch that already ran. The next run prunes.
    await pruneHourlyStats(nowMs).catch((error: unknown) => {
      logException(error, "stats.hourly_prune.failed");
    });
    // Best-effort telemetry: a failure must not fail the purge response.
    await reportTableSizes(executor).catch((error: unknown) => {
      logException(error, "db.table_size.failed");
    });
    return Response.json(result, { status: 200 });
  } catch (error) {
    logException(error, "retention.run.failed");
    return new Response("Retention purge failed", { status: 500 });
  }
}
