import { randomUUID } from "node:crypto";
import type { Destination, Source } from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { isUserActor, type Actor } from "@/chat/actor";
import type { CredentialContext } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import type {
  ToolAction,
  ToolApprovalRef,
  ToolApprovals,
} from "@/chat/guardian/gate";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { readActorIdentityFromSql } from "@/chat/plugins/viewer";
import { PLUGIN_REVIEW_ITEM_KEY_PREFIX } from "@/chat/review-items/access";
import type { ShowReviewItem } from "@/chat/review-items/changes";
import { insertReviewItem } from "@/chat/review-items/store";
import type { UserInputRequest } from "@/chat/tools/runtime/user-input-request";
import {
  findPendingToolApproval,
  getToolApprovalByCall,
  insertToolApproval,
} from "./store";

/**
 * Dedupe key prefix of the Review item of a Tool approval. "junior" is the
 * core namespace under the plugin prefix, so agents cannot add, change, or
 * close these items, and a thread reply does not answer them.
 */
export const TOOL_APPROVAL_REVIEW_ITEM_KEY_PREFIX = `${PLUGIN_REVIEW_ITEM_KEY_PREFIX}junior:tool-approval:`;

/** Field and choice labels of the approval question. */
export const TOOL_APPROVAL_FIELD_ID = "decision";
export const TOOL_APPROVAL_APPROVE = "Approve";
const TOOL_APPROVAL_DECLINE = "Decline";

const MAX_INPUT_CHARS = 2_500;

/** The Run context that a stored call keeps, so only that context runs it. */
export interface ToolApprovalRunContext {
  actor?: Actor;
  conversationId: string;
  credentialContext?: CredentialContext;
  destination: Destination;
  source: Source;
  turnId: string;
}

function approvalBody(proposal: ToolActionProposal, reason: string): string {
  const json = JSON.stringify(proposal.input, null, 2);
  const input =
    json.length > MAX_INPUT_CHARS
      ? `${json.slice(0, MAX_INPUT_CHARS)}\n… (cut)`
      : json;
  return [
    proposal.tool.proposalDescription ?? proposal.tool.description,
    "",
    `Why it needs approval: ${reason}`,
    "",
    "```json",
    input.replaceAll("```", "`\u200b``"),
    "```",
  ].join("\n");
}

const APPROVAL_REQUEST: UserInputRequest = {
  question:
    "Run this exact call? It runs once, only if you approve. Decline or dismiss to cancel it.",
  fields: [
    {
      id: TOOL_APPROVAL_FIELD_ID,
      kind: "choice",
      label: "Decision",
      options: [
        { label: TOOL_APPROVAL_APPROVE },
        { label: TOOL_APPROVAL_DECLINE },
      ],
    },
  ],
};

/**
 * Create the Tool approvals of one Run. The approver is the person who is
 * the Run's Actor. A child agent's Run carries its root person's Actor, so
 * the item goes to that person on the root's review desk. An Automation
 * run, or a Run of a system Actor, has no person who can answer, so a
 * request returns undefined and the gate denies the call.
 */
export function createToolApprovals(
  run: ToolApprovalRunContext,
  show: ShowReviewItem,
): ToolApprovals {
  const toRef = (approval: { reviewItemId: string }): ToolApprovalRef => ({
    reviewItemId: approval.reviewItemId,
  });
  return {
    async findPending(action: ToolAction) {
      const approval = await findPendingToolApproval(getDb(), {
        conversationId: run.conversationId,
        input: action.input,
        toolName: action.toolName,
      });
      return approval ? toRef(approval) : undefined;
    },
    async request(
      action: ToolAction,
      proposal: ToolActionProposal,
      reason: string,
    ) {
      const actor = run.actor;
      // No person can answer in an Automation run, as in Guardian.
      const kind = run.source.kind;
      if (
        kind === "scheduled_automation" ||
        kind === "event_automation" ||
        !isUserActor(actor)
      ) {
        return undefined;
      }
      const db = getDb();
      const existing = await getToolApprovalByCall(db, {
        conversationId: run.conversationId,
        toolCallId: action.toolCallId,
      });
      if (existing) return toRef(existing);
      const approver = (await readActorIdentityFromSql(db, actor))?.user;
      if (!approver) return undefined;
      const access = (
        await readConversationAccessFromSql(db, [run.conversationId])
      ).get(run.conversationId);
      if (!access?.rootConversationId) return undefined;
      const rootConversationId = access.rootConversationId;
      const id = randomUUID();
      const nowMs = Date.now();
      const approval = await db.transaction(async (tx) => {
        const item = await insertReviewItem(tx, {
          addedByConversationId: rootConversationId,
          ...(run.conversationId === rootConversationId
            ? { addedByTurnId: run.turnId }
            : undefined),
          assignedToEveryone: false,
          assigneeUserIds: [approver.id],
          body: approvalBody(proposal, reason),
          conversationIds: [rootConversationId],
          dedupeKey: `${TOOL_APPROVAL_REVIEW_ITEM_KEY_PREFIX}${id}`,
          kind: "action",
          nowMs,
          request: APPROVAL_REQUEST,
          title: `Approve ${action.toolName}?`,
          visibility: access.visibility === "public" ? "public" : "private",
          ...(access.tenant ? { tenant: access.tenant } : undefined),
        });
        if (!item) throw new Error(`Review item of approval ${id} exists`);
        return await insertToolApproval(tx, {
          actor,
          approverUserId: approver.id,
          conversationId: run.conversationId,
          destination: run.destination,
          id,
          input: action.input,
          nowMs,
          reviewItemId: item.id,
          toolCallId: action.toolCallId,
          toolName: action.toolName,
          turnId: run.turnId,
          ...(run.credentialContext
            ? { credentialContext: run.credentialContext }
            : undefined),
        });
      });
      await show(approval.reviewItemId);
      return toRef(approval);
    },
  };
}
