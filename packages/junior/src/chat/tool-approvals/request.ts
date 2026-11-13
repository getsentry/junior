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
import {
  getOpenReviewItemByDedupeKey,
  insertReviewItem,
} from "@/chat/review-items/store";
import type { UserInputRequest } from "@/chat/tools/runtime/user-input-request";
import {
  getToolApproval,
  listToolApprovals,
  requestToolApproval,
  sameStoredJson,
  type ToolApproval,
} from "./log";

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
 * Dedupe key of the Review item of one Tool approval. It names the
 * Conversation and the tool call, so an answer finds its request.
 */
function reviewItemDedupeKey(conversationId: string, toolCallId: string) {
  return `${TOOL_APPROVAL_REVIEW_ITEM_KEY_PREFIX}${encodeURIComponent(conversationId)}:${encodeURIComponent(toolCallId)}`;
}

/** Read the Conversation and tool call that a Tool approval item names. */
export function parseToolApprovalDedupeKey(
  dedupeKey: string,
): { conversationId: string; toolCallId: string } | undefined {
  if (!dedupeKey.startsWith(TOOL_APPROVAL_REVIEW_ITEM_KEY_PREFIX)) {
    return undefined;
  }
  const parts = dedupeKey
    .slice(TOOL_APPROVAL_REVIEW_ITEM_KEY_PREFIX.length)
    .split(":");
  if (parts.length !== 2) return undefined;
  return {
    conversationId: decodeURIComponent(parts[0]!),
    toolCallId: decodeURIComponent(parts[1]!),
  };
}

const toRef = (approval: ToolApproval): ToolApprovalRef => ({
  reviewItemId: approval.reviewItemId,
});

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
  return {
    async findPending(action: ToolAction) {
      const approval = (await listToolApprovals(run.conversationId)).find(
        (candidate) =>
          !candidate.end &&
          !candidate.claimTurnId &&
          candidate.toolName === action.toolName &&
          sameStoredJson(action.input, candidate.input),
      );
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
      const existing = await getToolApproval(
        run.conversationId,
        action.toolCallId,
      );
      if (existing) return toRef(existing);
      const db = getDb();
      const approver = (await readActorIdentityFromSql(db, actor))?.user;
      if (!approver) return undefined;
      const access = (
        await readConversationAccessFromSql(db, [run.conversationId])
      ).get(run.conversationId);
      if (!access?.rootConversationId) return undefined;
      const rootConversationId = access.rootConversationId;
      const dedupeKey = reviewItemDedupeKey(
        run.conversationId,
        action.toolCallId,
      );
      // The item comes first, so the request can name it. A retry after a
      // crash finds the open item by its key. An item without a request
      // runs nothing.
      const item =
        (await insertReviewItem(db, {
          addedByConversationId: rootConversationId,
          ...(run.conversationId === rootConversationId
            ? { addedByTurnId: run.turnId }
            : undefined),
          assignedToEveryone: false,
          assigneeUserIds: [approver.id],
          body: approvalBody(proposal, reason),
          conversationIds: [rootConversationId],
          dedupeKey,
          kind: "action",
          nowMs: Date.now(),
          request: APPROVAL_REQUEST,
          title: `Approve ${action.toolName}?`,
          visibility: access.visibility === "public" ? "public" : "private",
          ...(access.tenant ? { tenant: access.tenant } : undefined),
        })) ??
        (await getOpenReviewItemByDedupeKey(db, dedupeKey, access.tenant));
      if (!item) throw new Error(`Review item ${dedupeKey} is missing`);
      const approval = await requestToolApproval({
        conversationId: run.conversationId,
        nowMs: Date.now(),
        request: {
          actor,
          approverUserId: approver.id,
          destination: run.destination,
          input: action.input,
          reviewItemId: item.id,
          toolCallId: action.toolCallId,
          toolName: action.toolName,
          ...(run.credentialContext
            ? { credentialContext: run.credentialContext }
            : undefined),
        },
        turnId: run.turnId,
      });
      await show(approval.reviewItemId);
      return toRef(approval);
    },
  };
}
