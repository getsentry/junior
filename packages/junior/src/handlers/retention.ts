import { timingSafeEqual } from "node:crypto";
import { runRetentionPurge } from "@/chat/conversations/retention";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";

function getRetentionSecret(): string | undefined {
  return (
    process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim()
  );
}

function verifyRetentionRequest(request: Request): boolean {
  const secret = getRetentionSecret();
  if (!secret) {
    return false;
  }

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Handle the authenticated internal retention cron. One request runs a single
 * bounded purge batch and returns its counts. Failures are contained here so
 * retention can never affect task execution, heartbeat recovery, or delivery.
 */
export async function GET(request: Request): Promise<Response> {
  if (!verifyRetentionRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await runRetentionPurge(getSqlExecutor(), {
      nowMs: Date.now(),
    });
    return Response.json(result, { status: 200 });
  } catch (error) {
    logException(
      error,
      "retention_run_failed",
      {},
      {},
      "Retention purge run failed",
    );
    return new Response("Retention purge failed", { status: 500 });
  }
}
