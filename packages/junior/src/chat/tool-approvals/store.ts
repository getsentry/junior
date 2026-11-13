/**
 * Tool approvals: exact tool calls that wait for a person's approval on a
 * Review item. This module owns the lifecycle:
 *
 * - `pending` → `declined` when the item closes without an approval.
 * - `pending` → `running` when a Run claims the approved call. Only one Run
 *   can claim it, so the call runs at most once.
 * - `running` → `completed` or `failed` with the result that the agent sees.
 *
 * Each transition updates only a row in the state it expects, so a late or
 * repeated writer changes nothing.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Destination } from "@sentry/junior-plugin-api";
import type { Actor } from "@/chat/actor";
import type { CredentialContext } from "@/chat/credentials/context";
import type { JuniorDatabase } from "@/db/db";
import { juniorToolApprovals } from "@/db/schema";
import type { ToolApprovalStatus } from "@/db/schema/tool-approvals";

/** One stored call and who may approve it. */
export interface ToolApproval {
  actor: Actor;
  approverUserId: string;
  conversationId: string;
  credentialContext?: CredentialContext;
  destination: Destination;
  id: string;
  input: Record<string, unknown>;
  result?: string;
  reviewItemId: string;
  runTurnId?: string;
  status: ToolApprovalStatus;
  toolCallId: string;
  toolName: string;
  turnId: string;
}

type Row = typeof juniorToolApprovals.$inferSelect;

function fromRow(row: Row): ToolApproval {
  return {
    actor: row.actor,
    approverUserId: row.approverUserId,
    conversationId: row.conversationId,
    destination: row.destination,
    id: row.id,
    input: row.input,
    reviewItemId: row.reviewItemId,
    status: row.status,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    turnId: row.turnId,
    ...(row.credentialContext
      ? { credentialContext: row.credentialContext }
      : undefined),
    ...(row.result !== null ? { result: row.result } : undefined),
    ...(row.runTurnId ? { runTurnId: row.runTurnId } : undefined),
  };
}

/** Store one pending call. A second row for the same tool call throws. */
export async function insertToolApproval(
  db: JuniorDatabase,
  input: Omit<ToolApproval, "result" | "runTurnId" | "status"> & {
    nowMs: number;
  },
): Promise<ToolApproval> {
  const now = new Date(input.nowMs);
  const rows = await db
    .insert(juniorToolApprovals)
    .values({
      actor: input.actor,
      approverUserId: input.approverUserId,
      conversationId: input.conversationId,
      createdAt: now,
      credentialContext: input.credentialContext ?? null,
      destination: input.destination,
      id: input.id,
      input: input.input,
      reviewItemId: input.reviewItemId,
      status: "pending",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      turnId: input.turnId,
      updatedAt: now,
    })
    .returning();
  return fromRow(rows[0]!);
}

/** Read the approval of one tool call, so a retried call reuses it. */
export async function getToolApprovalByCall(
  db: JuniorDatabase,
  input: { conversationId: string; toolCallId: string },
): Promise<ToolApproval | undefined> {
  const rows = await db
    .select()
    .from(juniorToolApprovals)
    .where(
      and(
        eq(juniorToolApprovals.conversationId, input.conversationId),
        eq(juniorToolApprovals.toolCallId, input.toolCallId),
      ),
    );
  return rows[0] ? fromRow(rows[0]) : undefined;
}

/** Return the pending approval of one exact call in a Conversation. */
export async function findPendingToolApproval(
  db: JuniorDatabase,
  input: {
    conversationId: string;
    input: Record<string, unknown>;
    toolName: string;
  },
): Promise<ToolApproval | undefined> {
  const rows = await db
    .select()
    .from(juniorToolApprovals)
    .where(
      and(
        eq(juniorToolApprovals.conversationId, input.conversationId),
        eq(juniorToolApprovals.status, "pending"),
        eq(juniorToolApprovals.toolName, input.toolName),
        // jsonb equality ignores key order.
        sql`${juniorToolApprovals.input} = ${JSON.stringify(input.input)}::jsonb`,
      ),
    )
    .limit(1);
  return rows[0] ? fromRow(rows[0]) : undefined;
}

/** Read one Tool approval by the Review item that asks for it. */
export async function getToolApprovalByReviewItem(
  db: JuniorDatabase,
  reviewItemId: string,
): Promise<ToolApproval | undefined> {
  const rows = await db
    .select()
    .from(juniorToolApprovals)
    .where(eq(juniorToolApprovals.reviewItemId, reviewItemId));
  return rows[0] ? fromRow(rows[0]) : undefined;
}

/** List the approvals of one Conversation that a Run may still settle. */
export async function listOpenToolApprovals(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ToolApproval[]> {
  const rows = await db
    .select()
    .from(juniorToolApprovals)
    .where(
      and(
        eq(juniorToolApprovals.conversationId, conversationId),
        inArray(juniorToolApprovals.status, ["pending", "running"]),
      ),
    )
    .orderBy(juniorToolApprovals.createdAt, juniorToolApprovals.id);
  return rows.map(fromRow);
}

/** Move a pending approval to `declined`. Return false when it is not pending. */
export async function declineToolApproval(
  db: JuniorDatabase,
  input: { id: string; nowMs: number },
): Promise<boolean> {
  const updated = await db
    .update(juniorToolApprovals)
    .set({ status: "declined", updatedAt: new Date(input.nowMs) })
    .where(
      and(
        eq(juniorToolApprovals.id, input.id),
        eq(juniorToolApprovals.status, "pending"),
      ),
    )
    .returning({ id: juniorToolApprovals.id });
  return updated.length > 0;
}

/**
 * Claim a pending approval for one Turn. Return false when another Run
 * claimed it first or it is no longer pending.
 */
export async function claimToolApproval(
  db: JuniorDatabase,
  input: { id: string; nowMs: number; turnId: string },
): Promise<boolean> {
  const updated = await db
    .update(juniorToolApprovals)
    .set({
      runTurnId: input.turnId,
      status: "running",
      updatedAt: new Date(input.nowMs),
    })
    .where(
      and(
        eq(juniorToolApprovals.id, input.id),
        eq(juniorToolApprovals.status, "pending"),
      ),
    )
    .returning({ id: juniorToolApprovals.id });
  return updated.length > 0;
}

/** Store the result of a running call. Return false when it is not running. */
export async function finishToolApproval(
  db: JuniorDatabase,
  input: {
    id: string;
    nowMs: number;
    result: string;
    status: "completed" | "failed";
  },
): Promise<boolean> {
  const updated = await db
    .update(juniorToolApprovals)
    .set({
      result: input.result,
      status: input.status,
      updatedAt: new Date(input.nowMs),
    })
    .where(
      and(
        eq(juniorToolApprovals.id, input.id),
        eq(juniorToolApprovals.status, "running"),
      ),
    )
    .returning({ id: juniorToolApprovals.id });
  return updated.length > 0;
}
