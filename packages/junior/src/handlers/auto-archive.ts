import { runAutoArchiveSweep } from "@/api/conversations/auto-archive";
import { logException } from "@/chat/logging";
import { verifySchedulerRequest } from "@/handlers/scheduler-auth";

/**
 * Handle the authenticated auto-archive cron. One request runs one bounded
 * sweep. Failures stay here so archive state never affects task execution.
 */
export async function GET(request: Request): Promise<Response> {
  if (!verifySchedulerRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await runAutoArchiveSweep({ nowMs: Date.now() });
    return Response.json(result, { status: 200 });
  } catch (error) {
    logException(error, "auto_archive.run.failed");
    return new Response("Auto-archive failed", { status: 500 });
  }
}
