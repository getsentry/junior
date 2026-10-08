import { verifyCronRequest } from "@/handlers/cron-auth";
import { runRetentionPurge } from "@/chat/conversations/retention";
import { createVercelAttachmentStorage } from "@/chat/attachments/vercel";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";

/**
 * Handle the authenticated internal retention cron. One request runs a single
 * bounded purge batch and returns its counts. Failures are contained here so
 * retention can never affect task execution, heartbeat recovery, or delivery.
 */
export async function GET(
  request: Request,
  options: { attachmentStorage?: AttachmentStorage } = {},
): Promise<Response> {
  if (!verifyCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await runRetentionPurge(getSqlExecutor(), {
      attachmentStorage:
        options.attachmentStorage ?? createVercelAttachmentStorage(),
      nowMs: Date.now(),
    });
    return Response.json(result, { status: 200 });
  } catch (error) {
    logException(error, "retention.run.failed");
    return new Response("Retention purge failed", { status: 500 });
  }
}
