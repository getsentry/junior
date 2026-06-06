import { timingSafeEqual } from "node:crypto";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { logException } from "@/chat/logging";
import type { WaitUntilFn } from "@/handlers/types";

export interface HeartbeatHandlerOptions {
  conversationWorkQueue?: ConversationWorkQueue;
}

function getHeartbeatSecret(): string | undefined {
  return (
    process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim()
  );
}

function verifyHeartbeatRequest(request: Request): boolean {
  const secret = getHeartbeatSecret();
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

/** Handle the authenticated internal heartbeat. */
export async function GET(
  request: Request,
  waitUntil: WaitUntilFn,
  options: HeartbeatHandlerOptions = {},
): Promise<Response> {
  if (!verifyHeartbeatRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const nowMs = Date.now();
  waitUntil(() =>
    runHeartbeat({
      conversationWorkQueue: options.conversationWorkQueue,
      nowMs,
    }).catch((error) => {
      logException(
        error,
        "heartbeat_failed",
        {},
        { "app.heartbeat.now_ms": nowMs },
        "Heartbeat failed",
      );
    }),
  );

  return new Response("Accepted", { status: 202 });
}
