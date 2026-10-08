import { verifyCronRequest } from "@/handlers/cron-auth";
import { runCredentialSweep } from "@/chat/credentials/sweep";
import { logException } from "@/chat/logging";

/**
 * Handle the authenticated credential re-encryption cron. One request runs a
 * single bounded sweep batch and returns its counts. Failures stay here so the
 * sweep cannot affect task execution, heartbeat recovery, or delivery.
 */
export async function GET(request: Request): Promise<Response> {
  if (!verifyCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    return Response.json(await runCredentialSweep(), { status: 200 });
  } catch (error) {
    logException(error, "credential_sweep.run.failed");
    return new Response("Credential sweep failed", { status: 500 });
  }
}
