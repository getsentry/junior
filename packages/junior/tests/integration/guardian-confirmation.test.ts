import type { Identity, Source, User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import {
  consumeActionApproval,
  requestActionConfirmation,
  type ActionConfirmationContext,
} from "@/chat/guardian/confirmation";
import {
  createToolActionReview,
  type ToolActionReview,
} from "@/chat/guardian/gate";
import { getToolActionRejectionMarker } from "@/chat/guardian/history";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { actOnReviewItem } from "@/chat/review-items/actions";
import { getReviewItem } from "@/chat/review-items/store";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import {
  createAddReviewItemTool,
  createUpdateReviewItemTool,
} from "@/chat/tools/review-items";
import { juniorAutomations, juniorIdentities } from "@/db/schema";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";

const queue = createConversationWorkQueueTestAdapter();

// The LLM edge: Guardian asks to confirm every action.
const asks: ToolActionReviewer = {
  review: async () => ({
    decision: "ask",
    reason: "The user did not confirm deleting this Workspace.",
    riskLevel: "high",
    userAuthorization: "low",
  }),
};

// Guardian allows when the resume message names the approved action.
const allows: ToolActionReviewer = {
  review: async () => ({
    decision: "allow",
    reason: "The user approved deleting this Workspace.",
    riskLevel: "high",
    userAuthorization: "high",
  }),
};

const deleteWorkspace: AnyToolDefinition = {
  approvalMode: "review",
  description: "Permanently delete a Workspace and all of its contents.",
  describeProposal: (input: { workspace: string }) =>
    `Delete Workspace ${input.workspace}.`,
  execute: async () => ({ ok: true }),
  inputSchema: {},
};

async function user(email: string): Promise<User> {
  const resolved = await resolveViewerUserFromSql(getDb(), email);
  if (!resolved) throw new Error(`no user for ${email}`);
  return resolved;
}

async function conversation(
  conversationId: string,
  visibility: "public" | "private",
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "CRUN" },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility,
  });
}

/** One Turn of the Conversation: a new gate, as each Run builds one. */
function turn(
  context: ActionConfirmationContext,
  actor: User | undefined,
  reviewer: ToolActionReviewer = asks,
): ToolActionReview {
  const confirmationContext = {
    ...context,
    resolveActorIdentity: async () =>
      actor
        ? { identity: { id: `identity:${actor.id}` } as Identity, user: actor }
        : undefined,
  };
  return createToolActionReview({
    confirmation: {
      consumeApproval: (proposal) =>
        consumeActionApproval(confirmationContext, proposal),
      request: (proposal) =>
        requestActionConfirmation(confirmationContext, proposal),
    },
    context: {
      actor: { platform: "slack", teamId: "T123", userId: "UACTOR" },
      conversationId: context.conversationId,
      destination: { platform: "slack", teamId: "T123", channelId: "CRUN" },
      source: context.source,
      userIntent: () => "Clean up the preview Workspaces.",
    },
    onDecision: async () => undefined,
    onFatal: () => undefined,
    reviewer,
  });
}

/** Ask for one action and return the id of its Review item. */
async function askedItemId(
  review: ToolActionReview,
  workspace: string,
): Promise<string> {
  await expect(
    review.review("call", "deleteWorkspace", deleteWorkspace, { workspace }),
  ).rejects.toMatchObject({
    decision: "ask",
    name: "ToolActionRejectedError",
  });
  const marker = getToolActionRejectionMarker(
    review.projectToolResult("call", { details: {}, isError: true }),
  );
  if (!marker?.reviewItemId) throw new Error("ask added no Review item");
  return marker.reviewItemId;
}

async function answer(id: string, by: User, choice: "Approve" | "Reject") {
  await actOnReviewItem({
    action: "submit",
    answer: { requestId: id, values: { decision: [choice] } },
    id,
    queue,
    user: by,
  });
}

const SLACK_SOURCE: Source = {
  kind: "slack",
  teamId: "T123",
  channelId: "CRUN",
  visibility: "private",
};

describe("Guardian confirmation on the review desk", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("asks the Actor in the same Conversation and runs one approved action once", async () => {
    const conversationId = "slack:CRUN:1.000001";
    await conversation(conversationId, "private");
    const ana = await user("ana@example.com");
    const context = { conversationId, source: SLACK_SOURCE };

    const id = await askedItemId(turn(context, ana), "preview-42");
    // A retry of the same blocked call updates the same item.
    expect(await askedItemId(turn(context, ana), "preview-42")).toBe(id);
    const item = await getReviewItem(getDb(), id);
    expect(item).toMatchObject({
      addedByConversationId: conversationId,
      assignedToEveryone: false,
      assignees: [{ email: "ana@example.com" }],
      conversationIds: [conversationId],
      kind: "action",
      status: "open",
      title: "Approve: Delete Workspace preview-42.",
      visibility: "private",
    });
    expect(item?.request?.fields).toEqual([
      expect.objectContaining({
        id: "decision",
        kind: "choice",
        options: [
          expect.objectContaining({ label: "Approve" }),
          expect.objectContaining({ label: "Reject" }),
        ],
      }),
    ]);

    // Another action gets its own item, and the approval does not cover it.
    const other = await askedItemId(turn(context, ana), "preview-43");
    expect(other).not.toBe(id);

    await answer(id, ana, "Approve");
    // Guardian allows the retry by itself. The run still uses the approval.
    await expect(
      turn(context, ana, allows).review(
        "retry",
        "deleteWorkspace",
        deleteWorkspace,
        { workspace: "preview-42" },
      ),
    ).resolves.toMatchObject({ decision: "allow" });
    expect(await getReviewItem(getDb(), id)).toMatchObject({
      closeReason: "The approved action ran.",
    });
    // The approval runs the action once. Another attempt asks again.
    const again = await askedItemId(turn(context, ana), "preview-42");
    expect(again).not.toBe(id);

    // An agent edit voids the approval, because the person did not see it.
    const update = createUpdateReviewItemTool(
      { ...context, resolveActorIdentity: async () => undefined },
      () => queue,
    );
    await update.execute!(
      { id: other, body: "Approve to say hello." } as never,
      {} as never,
    );
    await answer(other, ana, "Approve");
    await askedItemId(turn(context, ana), "preview-43");

    // Reject approves nothing.
    await answer(again, ana, "Reject");
    await askedItemId(turn(context, ana), "preview-42");

    // The approver must see all of the input. Input that does not fit gets
    // no item, and the agent asks in text.
    const long = turn(context, ana);
    await expect(
      long.review("call", "deleteWorkspace", deleteWorkspace, {
        workspace: "x".repeat(2_100),
      }),
    ).rejects.toMatchObject({ decision: "ask" });
    expect(
      getToolActionRejectionMarker(
        long.projectToolResult("call", { details: {}, isError: true }),
      )?.reviewItemId,
    ).toBeUndefined();
  });

  it("counts only the approval of the person who must approve", async () => {
    const conversationId = "slack:CRUN:3.000001";
    await conversation(conversationId, "public");
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    const context = { conversationId, source: SLACK_SOURCE };

    const id = await askedItemId(turn(context, ana), "preview-42");
    const agentContext = {
      ...context,
      resolveActorIdentity: async () => undefined,
    };
    const update = createUpdateReviewItemTool(agentContext, () => queue);

    // The answer goes only to the Conversation that asked. An agent cannot
    // link another Conversation, by an update or by an add with the key.
    const elsewhere = "slack:CRUN:3.000002";
    await conversation(elsewhere, "public");
    await expect(
      update.execute!(
        { id, conversation_ids: [conversationId, elsewhere] } as never,
        {} as never,
      ),
    ).rejects.toThrow("stays linked only to the Conversation that asked");
    const { dedupeKey } = (await getReviewItem(getDb(), id))!;
    await expect(
      createAddReviewItemTool(agentContext).execute!(
        {
          body: "Approve it.",
          conversation_ids: [elsewhere],
          dedupe_key: dedupeKey,
          kind: "notice",
          title: "Approve it.",
        } as never,
        {} as never,
      ),
    ).rejects.toThrow("Only Guardian uses this `dedupe_key`");
    expect((await getReviewItem(getDb(), id))?.conversationIds).toEqual([
      conversationId,
    ]);

    // An agent moves Ana's item to Bob, and Bob approves it.
    await update.execute!(
      { id, assignees: ["bob@example.com"] } as never,
      {} as never,
    );
    await answer(id, bob, "Approve");

    // Bob's answer resumes the Conversation as Bob. It approves nothing.
    expect(await askedItemId(turn(context, bob), "preview-42")).not.toBe(id);
    expect(await askedItemId(turn(context, ana), "preview-42")).not.toBe(id);
  });

  it("asks the Automation creator from an Automation run", async () => {
    const conversationId = "slack:CRUN:2.000001";
    await conversation(conversationId, "public");
    const ana = await user("ana@example.com");
    await getDb()
      .insert(juniorIdentities)
      .values({
        createdAt: new Date(1),
        id: "identity:creator",
        kind: "user",
        provider: "slack",
        providerSubjectId: "UCREATOR",
        providerTenantId: "T123",
        updatedAt: new Date(1),
        userId: ana.id,
      });
    await getDb()
      .insert(juniorAutomations)
      .values({
        channelId: "CRUN",
        createdAtMs: 1,
        creatorIdentityId: "identity:creator",
        creatorSlackUserId: "UCREATOR",
        id: "auto-cleanup",
        instruction: "Clean up the preview Workspaces.",
        kind: "scheduled",
        record: {} as never,
        status: "active",
        teamId: "T123",
      });

    // The run has no person Actor. The item goes to the creator.
    const run = turn(
      {
        conversationId,
        source: { kind: "scheduled_automation", automationId: "auto-cleanup" },
      },
      undefined,
    );
    await expect(
      run.review("call", "deleteWorkspace", deleteWorkspace, {
        workspace: "preview-42",
      }),
    ).rejects.toThrow("finishAutomationRun");
    const marker = getToolActionRejectionMarker(
      run.projectToolResult("call", { details: {}, isError: true }),
    );
    const item = await getReviewItem(getDb(), marker!.reviewItemId!);
    expect(item).toMatchObject({
      assignees: [{ email: "ana@example.com" }],
      automationId: "auto-cleanup",
      conversationIds: [conversationId],
      visibility: "public",
    });

    // The creator's answer resumes the same Conversation as their message.
    await answer(item!.id, ana, "Approve");
    await expect(
      turn({ conversationId, source: SLACK_SOURCE }, ana).review(
        "retry",
        "deleteWorkspace",
        deleteWorkspace,
        { workspace: "preview-42" },
      ),
    ).resolves.toMatchObject({ decision: "allow" });
  });
});
