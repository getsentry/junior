import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { logException } from "@/chat/logging";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { getSandboxProvider } from "@/chat/sandbox/provider";
import {
  stopSession,
  type SandboxSession,
  type SandboxSessionCost,
} from "@/chat/sandbox/workspace";
import { juniorConversations, juniorSandboxSessions } from "@/db/schema";

// Module overview: estimated Sandbox cost for each Conversation.
//
// Junior records each VM session that a Conversation's Sandbox opens. The
// provider reports usage only after the session stops, and Junior rarely
// stops a conversation Sandbox itself: it times out after the Turn. So the
// heartbeat sweep reads the usage later. A stop that Junior makes writes the
// cost at once.

/** Wait this long before the first read. Most sessions are still running. */
const FIRST_CHECK_DELAY_MS = 10 * 60 * 1000;
const RECHECK_DELAY_MS = 10 * 60 * 1000;
/**
 * Stop reading after this age. Vercel removes a non-persistent Sandbox, and
 * its session records, after 14 days without use.
 */
const MAX_RECORD_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 20;
const READ_TIMEOUT_MS = 10_000;

/**
 * Record a VM session that a Conversation's Sandbox opened. A failure costs
 * only this estimate, so it is logged and the Sandbox keeps working.
 */
export async function recordSandboxSession(args: {
  /** Unset when no Conversation owns the Sandbox runtime. */
  conversationId: string | undefined;
  session: Pick<SandboxSession, "sandboxId" | "sessionId">;
  createdSandbox: boolean;
  nowMs?: number;
}): Promise<void> {
  if (!args.conversationId || !getSandboxProvider().readSessionCost) return;
  const nowMs = args.nowMs ?? Date.now();
  try {
    await getSqlExecutor()
      .db()
      .insert(juniorSandboxSessions)
      .values({
        sessionId: args.session.sessionId,
        sandboxId: args.session.sandboxId,
        conversationId: args.conversationId,
        createdSandbox: args.createdSandbox,
        checkAfter: new Date(nowMs + FIRST_CHECK_DELAY_MS),
        createdAt: new Date(nowMs),
      })
      .onConflictDoNothing();
  } catch (error) {
    logException(error, "sandbox.cost.record_failed", {
      "app.sandbox.session_id": args.session.sessionId,
    });
  }
}

/**
 * Write the cost of one recorded session, once. A `missing` cost settles the
 * record without a cost. A `pending` cost waits for the sweep.
 */
export async function settleSandboxSessionCost(args: {
  sessionId: string;
  cost: SandboxSessionCost;
  nowMs?: number;
}): Promise<void> {
  if (args.cost.status === "pending") return;
  const costUsd = args.cost.status === "ready" ? args.cost.costUsd : null;
  const now = new Date(args.nowMs ?? Date.now());
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    const [record] = await db
      .update(juniorSandboxSessions)
      .set({ costUsd, settledAt: now })
      .where(
        and(
          eq(juniorSandboxSessions.sessionId, args.sessionId),
          isNull(juniorSandboxSessions.settledAt),
        ),
      )
      .returning({ conversationId: juniorSandboxSessions.conversationId });
    if (!record || costUsd === null) return;

    // The total is the sum of the settled sessions, so a repeat write gives
    // the same value. Lock the Conversation first so that the sum below, a
    // new statement, sees a concurrent settle that committed before it.
    await db
      .select({ conversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, record.conversationId))
      .for("update");
    await db
      .update(juniorConversations)
      .set({
        sandboxCostUsd: sql`(
          select sum(${juniorSandboxSessions.costUsd})
          from ${juniorSandboxSessions}
          where ${juniorSandboxSessions.conversationId} = ${record.conversationId}
        )`,
        detailVersion: nextDetailVersion,
      })
      .where(eq(juniorConversations.conversationId, record.conversationId));
  });
}

/**
 * Best-effort stop for cleanup that also writes the session's cost when the
 * provider returns it. Neither failure reaches the caller.
 */
export async function stopSandboxSession(
  session: Pick<SandboxSession, "sessionId" | "stop"> | null | undefined,
): Promise<void> {
  const cost = await stopSession(session);
  if (!session || !cost) return;
  try {
    await settleSandboxSessionCost({ sessionId: session.sessionId, cost });
  } catch (error) {
    logException(error, "sandbox.cost.settle_failed", {
      "app.sandbox.session_id": session.sessionId,
    });
  }
}

/**
 * Read the usage of recorded sessions that are due, in one bounded batch.
 * Safe to run twice at once: a settled record is never written again.
 */
export async function runSandboxCostSweep(args: {
  nowMs: number;
}): Promise<void> {
  const readSessionCost = getSandboxProvider().readSessionCost;
  if (!readSessionCost) return;
  const db = getSqlExecutor().db();
  const due = await db
    .select()
    .from(juniorSandboxSessions)
    .where(
      and(
        isNull(juniorSandboxSessions.settledAt),
        lte(juniorSandboxSessions.checkAfter, new Date(args.nowMs)),
      ),
    )
    .orderBy(asc(juniorSandboxSessions.checkAfter))
    .limit(SWEEP_LIMIT);

  for (const record of due) {
    const settle = (cost: SandboxSessionCost) =>
      settleSandboxSessionCost({
        sessionId: record.sessionId,
        cost,
        nowMs: args.nowMs,
      });
    if (args.nowMs - record.createdAt.getTime() >= MAX_RECORD_AGE_MS) {
      await settle({ status: "missing" });
      continue;
    }
    let cost: SandboxSessionCost;
    try {
      cost = await readSessionCost({
        sandboxId: record.sandboxId,
        sessionId: record.sessionId,
        createdSandbox: record.createdSandbox,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (error) {
      logException(error, "sandbox.cost.read_failed", {
        "app.sandbox.session_id": record.sessionId,
      });
      cost = { status: "pending" };
    }
    if (cost.status === "pending") {
      await db
        .update(juniorSandboxSessions)
        .set({ checkAfter: new Date(args.nowMs + RECHECK_DELAY_MS) })
        .where(eq(juniorSandboxSessions.sessionId, record.sessionId));
      continue;
    }
    await settle(cost);
  }
}
