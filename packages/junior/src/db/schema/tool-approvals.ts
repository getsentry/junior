import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Destination } from "@sentry/junior-plugin-api";
import type { Actor } from "@/chat/actor";
import type { CredentialContext } from "@/chat/credentials/context";
import { juniorConversations } from "./conversations";
import { juniorReviewItems } from "./review-items";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/** Lifecycle of one Tool approval. `tool-approvals/store.ts` owns it. */
export type ToolApprovalStatus =
  | "pending"
  | "declined"
  | "running"
  | "completed"
  | "failed";

/**
 * One Tool approval: an exact tool call that waits for a person's approval
 * on a Review item. The row keeps the context of the Run that made the
 * call, so only a Run with the same Actor, credential context, and
 * Destination can run it. It holds ids, not credentials. `run_turn_id` is
 * set from `running` on. `result` is set for `completed` and `failed`.
 */
export const juniorToolApprovals = pgTable(
  "junior_tool_approvals",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    turnId: text("turn_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    actor: jsonb("actor").$type<Actor>().notNull(),
    credentialContext: jsonb("credential_context").$type<CredentialContext>(),
    destination: jsonb("destination").$type<Destination>().notNull(),
    approverUserId: text("approver_user_id")
      .notNull()
      .references(() => juniorUsers.id, { onDelete: "cascade" }),
    reviewItemId: text("review_item_id")
      .notNull()
      .references(() => juniorReviewItems.id, { onDelete: "cascade" }),
    status: text("status").$type<ToolApprovalStatus>().notNull(),
    runTurnId: text("run_turn_id"),
    result: text("result"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check(
      "junior_tool_approvals_status_check",
      sql`(${table.status} in ('pending', 'declined') and ${table.runTurnId} is null and ${table.result} is null) or (${table.status} = 'running' and ${table.runTurnId} is not null and ${table.result} is null) or (${table.status} in ('completed', 'failed') and ${table.runTurnId} is not null and ${table.result} is not null)`,
    ),
    uniqueIndex("junior_tool_approvals_call_uidx").on(
      table.conversationId,
      table.toolCallId,
    ),
    index("junior_tool_approvals_conversation_idx").on(
      table.conversationId,
      table.status,
    ),
  ],
);
