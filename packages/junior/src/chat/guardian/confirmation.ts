/**
 * Owns the Review item for a Guardian `ask`: one Approve or Reject request
 * for one exact action, and the one-time use of its approval.
 *
 * Core adds the item from the gate. It does not use the model tool.
 */
import { createHash } from "node:crypto";
import { getDb } from "@/chat/db";
import {
  canonicalJson,
  type ToolActionProposal,
} from "@/chat/guardian/proposal";
import {
  canAgentChangeReviewItem,
  readReviewItemAgentScope,
  requireReviewItemAssignees,
} from "@/chat/review-items/access";
import { automationCreatorUserId } from "@/chat/review-items/assignees";
import {
  getLatestReviewItemByDedupeKey,
  getOpenReviewItemByDedupeKey,
  insertReviewItem,
  markReviewItemApprovalUsed,
  updateReviewItemContent,
  type ReviewItem,
  type ReviewItemContent,
} from "@/chat/review-items/store";
import { syncReviewItemSlackCards } from "@/chat/slack/review-item-card-sync";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { UserInputRequest } from "@/chat/tools/runtime/user-input-request";

/** The Run facts that add and read a confirmation item. */
export type ActionConfirmationContext = Pick<
  ToolRuntimeContext,
  "conversationId" | "resolveActorIdentity" | "source"
>;

const DECISION_FIELD_ID = "decision";
const APPROVE = "Approve";
const REJECT = "Reject";
const APPROVAL_USED_REASON = "The approved action ran.";
const MAX_ACTION_CHARS = 180;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_INPUT_CHARS = 2_000;
const CONFIRMATION_KEY_PREFIX = "guardian:";

/**
 * Whether a dedupe key belongs to a Guardian confirmation item. Only core
 * adds these items, and their links stay fixed, so an approval sends the
 * answer of the approver only to the Conversation that asked.
 */
export function isActionConfirmationKey(dedupeKey: string): boolean {
  return dedupeKey.startsWith(CONFIRMATION_KEY_PREFIX);
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** A code fence that no backtick run in `text` can close. */
function fenced(text: string, language: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, text, fence].join("\n");
}

/**
 * Who an item belongs to: the Automation that added it, whose creator
 * approves, or the Actor who must approve. It is part of the dedupe key, so
 * an agent cannot move an approval to another person by a change to the
 * assignees.
 */
type ConfirmationOwner = "automation" | `user:${string}`;

/**
 * The dedupe key of the confirmation item for one exact action of one owner
 * in one Conversation: the tool and its exact input. A retry of the same
 * blocked call has the same key, so it updates the open item.
 */
function confirmationKey(
  conversationId: string,
  owner: ConfirmationOwner,
  proposal: ToolActionProposal,
): string {
  const action = canonicalJson({
    dispatcherName: proposal.tool.dispatcherName ?? null,
    input: proposal.input,
    name: proposal.tool.name,
  });
  const hash = createHash("sha256")
    .update(JSON.stringify([conversationId, owner, action]))
    .digest("hex");
  return `${CONFIRMATION_KEY_PREFIX}${hash}`;
}

/**
 * Render the item content from the proposal only, so the same action always
 * gets the same content. The approval check compares the item with this
 * render, so an item that an agent changed no longer approves anything.
 * Return undefined when the exact input does not fit in the body: the
 * approver must see all of the input that they approve.
 */
function confirmationContent(
  proposal: ToolActionProposal,
):
  | (Pick<ReviewItemContent, "body" | "title"> & { request: UserInputRequest })
  | undefined {
  const input = JSON.stringify(canonicalJson(proposal.input), null, 2);
  if (input.length > MAX_INPUT_CHARS) return undefined;
  const action = truncate(
    proposal.tool.proposalDescription ?? `Run \`${proposal.tool.name}\`.`,
    MAX_ACTION_CHARS,
  );
  const tool = proposal.tool.dispatcherName
    ? `\`${proposal.tool.name}\` (through \`${proposal.tool.dispatcherName}\`)`
    : `\`${proposal.tool.name}\``;
  return {
    title: `Approve: ${action}`,
    body: [
      "Junior stopped before this action. It needs your approval first.",
      "",
      `**Action:** ${action}`,
      `**Tool:** ${tool}`,
      `**What the tool does:** ${truncate(proposal.tool.description, MAX_DESCRIPTION_CHARS)}`,
      "",
      "**Exact input:**",
      fenced(input, "json"),
      "",
      `${APPROVE} runs this exact action one time. ${REJECT} means it does not run.`,
    ].join("\n"),
    request: {
      question: `Approve this action? ${action}`,
      fields: [
        {
          id: DECISION_FIELD_ID,
          kind: "choice",
          label: "Decision",
          options: [
            {
              label: APPROVE,
              description: "Run this exact action one time.",
            },
            { label: REJECT, description: "Do not run it." },
          ],
        },
      ],
    },
  };
}

/**
 * The User who must approve an action: the creator of the Automation, for
 * an Automation run or an item that one added, and otherwise the Actor.
 */
async function approverUserId(
  automationId: string | undefined,
  actorUserId: string | undefined,
): Promise<string | undefined> {
  return automationId
    ? await automationCreatorUserId(getDb(), automationId)
    : actorUserId;
}

/**
 * Add the Approve/Reject item for one exact action, or update the open one
 * for the same action. It links the current Conversation, so its card shows
 * in the thread and the Conversation shows as waiting on the approver.
 * Return the item id, or undefined when no User can approve, such as an
 * Actor without a Junior User, or when the input is too long to show.
 */
export async function requestActionConfirmation(
  context: ActionConfirmationContext,
  proposal: ToolActionProposal,
): Promise<string | undefined> {
  const db = getDb();
  const scope = await readReviewItemAgentScope(context);
  const approver = await approverUserId(
    scope.reader.automationId,
    scope.user?.id,
  );
  const rendered = confirmationContent(proposal);
  if (!approver || !rendered) return undefined;
  const dedupeKey = confirmationKey(
    context.conversationId,
    scope.reader.automationId ? "automation" : `user:${approver}`,
    proposal,
  );
  const existing = await getOpenReviewItemByDedupeKey(
    db,
    dedupeKey,
    scope.tenant,
  );
  // Only an item of this Conversation can carry its action. Another
  // Conversation that took the key cannot get this content.
  if (
    existing &&
    (existing.addedByConversationId !== context.conversationId ||
      !canAgentChangeReviewItem(existing, scope))
  ) {
    return undefined;
  }
  const visibility =
    scope.inPrivateConversation || existing?.visibility === "private"
      ? "private"
      : "public";
  const assignees = { everyone: false, userIds: [approver] };
  await requireReviewItemAssignees({
    assignees,
    automationId: scope.reader.automationId,
    conversationIds: [context.conversationId],
    scope,
    visibility,
  });
  const content: ReviewItemContent = {
    ...rendered,
    assignedToEveryone: false,
    assigneeUserIds: assignees.userIds,
    // Only the Conversation that asked gets the answer.
    conversationIds: [context.conversationId],
    kind: "action",
    visibility,
  };
  const nowMs = Date.now();
  let itemId: string | undefined;
  if (existing) {
    if (
      await updateReviewItemContent(db, { ...content, id: existing.id, nowMs })
    ) {
      itemId = existing.id;
    }
  } else {
    itemId = (
      await insertReviewItem(db, {
        ...content,
        addedByConversationId: context.conversationId,
        dedupeKey,
        nowMs,
        ...(scope.reader.automationId
          ? { automationId: scope.reader.automationId }
          : undefined),
        ...(scope.tenant ? { tenant: scope.tenant } : undefined),
      })
    )?.id;
  }
  // A concurrent close or add won the race. The agent asks in text.
  if (!itemId) return undefined;
  await syncReviewItemSlackCards({ itemId });
  return itemId;
}

function isUnchangedApproval(
  item: ReviewItem,
  proposal: ToolActionProposal,
): boolean {
  const expected = confirmationContent(proposal);
  if (!expected) return false;
  const values = item.answer?.values[DECISION_FIELD_ID];
  return (
    item.kind === "action" &&
    item.status === "done" &&
    item.closeReason === undefined &&
    item.title === expected.title &&
    item.body === expected.body &&
    // Postgres `jsonb` does not keep key order.
    JSON.stringify(canonicalJson(item.request)) ===
      JSON.stringify(canonicalJson(expected.request)) &&
    values?.length === 1 &&
    values[0] === APPROVE &&
    // A note can limit the approval, so Guardian reads it instead.
    !item.answer?.other
  );
}

/**
 * Consume the approval of this exact action, if the approver gave one. It is
 * true only once for each approval: for the newest item of this exact
 * action in this Conversation, when that item is unchanged, and when the
 * approver closed it with Approve and no note. The item of the current
 * Actor comes first, then the item of an Automation run. A retry after that
 * needs a new approval.
 */
export async function consumeActionApproval(
  context: ActionConfirmationContext,
  proposal: ToolActionProposal,
): Promise<boolean> {
  const db = getDb();
  const scope = await readReviewItemAgentScope(context);
  const owners: ConfirmationOwner[] = scope.reader.automationId
    ? ["automation"]
    : [...(scope.user ? [`user:${scope.user.id}` as const] : []), "automation"];
  for (const owner of owners) {
    const item = await getLatestReviewItemByDedupeKey(
      db,
      confirmationKey(context.conversationId, owner, proposal),
      scope.tenant,
    );
    if (
      !item ||
      item.addedByConversationId !== context.conversationId ||
      // Only an Automation run adds an item with the automation owner.
      (owner === "automation") !== (item.automationId !== undefined) ||
      !isUnchangedApproval(item, proposal)
    ) {
      continue;
    }
    const approver = await approverUserId(item.automationId, scope.user?.id);
    if (!approver || item.closedBy?.userId !== approver) continue;
    return await markReviewItemApprovalUsed(db, {
      id: item.id,
      nowMs: Date.now(),
      reason: APPROVAL_USED_REASON,
    });
  }
  return false;
}
