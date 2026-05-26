import { processDueScheduledRuns } from "@/chat/scheduler/executor";
import { createSlackScheduledTaskRunner } from "@/chat/scheduler/slack-runner";
import { createStateSchedulerStore } from "@/chat/scheduler/store";
import { logException } from "@/chat/logging";
import type { WaitUntilFn } from "@/handlers/types";

const DEFAULT_SCHEDULER_TICK_LIMIT = 10;

function getSchedulerSecret(): string | undefined {
  return (
    process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim()
  );
}

function verifySchedulerRequest(request: Request): boolean {
  const secret = getSchedulerSecret();
  if (!secret) {
    return false;
  }

  const authorization = request.headers.get("authorization")?.trim();
  return authorization === `Bearer ${secret}`;
}

/** Handle the authenticated internal scheduler tick. */
export async function GET(
  request: Request,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  if (!verifySchedulerRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const nowMs = Date.now();
  waitUntil(() =>
    processDueScheduledRuns({
      store: createStateSchedulerStore(),
      runner: createSlackScheduledTaskRunner(),
      nowMs,
      limit: DEFAULT_SCHEDULER_TICK_LIMIT,
    }).catch((error) => {
      logException(
        error,
        "scheduler_tick_failed",
        {},
        {
          "app.scheduler.now_ms": nowMs,
        },
        "Scheduler tick failed",
      );
    }),
  );

  return new Response("Accepted", { status: 202 });
}
