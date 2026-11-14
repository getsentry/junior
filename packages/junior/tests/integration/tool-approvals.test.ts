import { createSlackSource, type Source } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationEventStore, getDb } from "@/chat/db";
import {
  createToolActionReview,
  reviewToolActions,
} from "@/chat/guardian/gate";
import {
  actOnReviewItem,
  ReviewItemActionError,
} from "@/chat/review-items/actions";
import {
  getReviewItem,
  listWaitingConversations,
} from "@/chat/review-items/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { getConversation } from "@/chat/task-execution/store";
import {
  createToolApprovalRequest,
  listToolApprovals,
  runApprovedToolCalls,
  type ToolApprovalRunContext,
} from "@/chat/tool-approvals";
import { createToolPipeline } from "@/chat/tool-support/pi-tool-adapter";
import { tool, type AnyToolDefinition } from "@/chat/tools/definition";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId as rootId,
} from "../fixtures/agent-invocations";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { linkSlackUser } from "../fixtures/slack-user";

const TOOL = "records_delete";
const alice = slackInvocationInput.actor;
const rootSource = createSlackSource({
  channelId: "C123",
  teamId: "T123",
  threadTs: "1712345.0001",
  visibility: "public",
});

let executions: Array<Record<string, unknown>> = [];

/** A tool that must wait for the person's approval of each call. */
const deleteRecord = tool({
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: "Delete one record for good.",
  inputSchema: Type.Object({ id: Type.String() }),
  permission: "ask",
  execute: async (input) => {
    executions.push(input);
    return { deleted: input.id };
  },
}) as AnyToolDefinition;

function runContext(
  overrides: Partial<ToolApprovalRunContext> = {},
): ToolApprovalRunContext {
  return {
    actor: alice,
    conversationId: rootId,
    destination: slackDestination,
    source: rootSource,
    turnId: "turn-1",
    ...overrides,
  };
}

/**
 * The tool path of one Run, as `wireAgentTools` builds it: calls go
 * through action review with this Run's Tool approvals, and approved calls
 * run through a pipeline without review. Guardian never sees an `ask` call.
 */
function wireRun(run: ToolApprovalRunContext) {
  const review = createToolActionReview({
    context: {
      actor: run.actor,
      conversationId: run.conversationId,
      destination: run.destination,
      source: run.source,
      userIntent: () => "Delete record r-1.",
    },
    onDecision: async () => undefined,
    onFatal: (error) => {
      throw error;
    },
    requestApproval: createToolApprovalRequest(run, async () => {}),
    reviewer: {
      review: async () => {
        throw new Error("Guardian must not review an ask call");
      },
    },
  });
  const pipelineOptions = {
    catalogTools: {},
    conversationPrivacy: "private" as const,
    sandbox: new SkillSandbox([], []),
    spanContext: {},
  };
  const approved = createToolPipeline(pipelineOptions);
  return {
    /** Make the model's call and return its review result. */
    async call(toolCallId: string, input: Record<string, unknown>) {
      const results = await reviewToolActions(
        [{ input, tool: deleteRecord, toolCallId, toolName: TOOL }],
        review,
      );
      return results.get(toolCallId)!;
    },
    async runApproved() {
      return await runApprovedToolCalls({
        pipeline: approved,
        run,
        show: async () => {},
        tools: { [TOOL]: deleteRecord },
      });
    },
  };
}

/** The one stored call of a Conversation, from its event log. */
async function onlyApproval(conversationId: string) {
  const approvals = await listToolApprovals(conversationId);
  expect(approvals).toHaveLength(1);
  return approvals[0]!;
}

function answer(args: {
  action: "submit" | "dismiss";
  decision?: "Approve" | "Decline";
  itemId: string;
  queue?: ReturnType<typeof createConversationWorkQueueTestAdapter>;
  user: Awaited<ReturnType<typeof linkSlackUser>>;
}) {
  return actOnReviewItem({
    action: args.action,
    ...(args.action === "submit"
      ? {
          answer: {
            requestId: args.itemId,
            values: { decision: [args.decision ?? "Approve"] },
          },
        }
      : undefined),
    delivery: {
      queue: args.queue ?? createConversationWorkQueueTestAdapter(),
      show: async () => {},
    },
    id: args.itemId,
    user: args.user,
  });
}

/** Ask for r-1 in the root and return the stored approval. */
async function askInRoot() {
  const run = wireRun(runContext());
  const result = await run.call("call-1", { id: "r-1" });
  return { approval: await onlyApproval(rootId), result, run };
}

describe("tool approvals", () => {
  let aliceUser: Awaited<ReturnType<typeof linkSlackUser>>;
  let conversationStore: Awaited<
    ReturnType<typeof prepareSlackParentConversation>
  >["conversationStore"];

  beforeEach(async () => {
    executions = [];
    ({ conversationStore } = await prepareSlackParentConversation());
    aliceUser = await linkSlackUser("alice@example.com", alice.userId);
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("files an ask on the person's review desk and does not run the call", async () => {
    const { approval, result } = await askInRoot();

    expect(result.allowed).toBe(false);
    expect(result.allowed ? undefined : result.error.message).toContain(
      `It waits for the person's approval on review item ${approval.reviewItemId}`,
    );
    expect(executions).toEqual([]);
    expect(approval).toMatchObject({
      approverUserId: aliceUser.id,
      input: { id: "r-1" },
      toolName: TOOL,
    });
    await expect(
      getReviewItem(getDb(), approval.reviewItemId),
    ).resolves.toMatchObject({
      addedByConversationId: rootId,
      assignees: [expect.objectContaining({ userId: aliceUser.id })],
      conversationIds: [rootId],
      kind: "action",
      status: "open",
    });
    // A retry of the same tool call, and an identical new call, reuse the
    // open item and its stored request.
    const again = wireRun(runContext({ turnId: "turn-2" }));
    expect((await again.call("call-1", { id: "r-1" })).allowed).toBe(false);
    const retry = await again.call("call-2", { id: "r-1" });
    expect(retry.allowed ? undefined : retry.error.message).toContain(
      `review item ${approval.reviewItemId}`,
    );
    await expect(onlyApproval(rootId)).resolves.toMatchObject({
      reviewItemId: approval.reviewItemId,
      toolCallId: "call-1",
    });
  });

  it("runs the exact stored call once after the approver approves, also when the approval is replayed", async () => {
    const { approval } = await askInRoot();

    await answer({
      action: "submit",
      itemId: approval.reviewItemId,
      user: aliceUser,
    });
    // Two Turns pick up the same approval at once.
    const [first, second] = await Promise.all([
      wireRun(runContext({ turnId: "turn-2" })).runApproved(),
      wireRun(runContext({ turnId: "turn-3" })).runApproved(),
    ]);

    expect(executions).toEqual([{ id: "r-1" }]);
    expect([...first, ...second]).toEqual([
      expect.stringContaining(
        `<tool-approval-result id="${approval.reviewItemId}" status="completed" tool="${TOOL}">`,
      ),
    ]);
    expect(await onlyApproval(rootId)).toMatchObject({
      decision: "allow",
    });
    // One person decision, the claim, exists for the request.
    const decisions = (
      await getConversationEventStore().loadHistory(rootId)
    ).filter((event) => event.data.type === "action_decided");
    expect(decisions.map((event) => event.data)).toEqual([
      expect.objectContaining({
        decider: "person",
        decision: "allow",
        toolCallId: approval.toolCallId,
      }),
    ]);

    // The same answer again, then a new Turn, run nothing.
    await answer({
      action: "submit",
      itemId: approval.reviewItemId,
      user: aliceUser,
    });
    await expect(
      wireRun(runContext({ turnId: "turn-4" })).runApproved(),
    ).resolves.toEqual([]);
    expect(executions).toEqual([{ id: "r-1" }]);
  });

  it.each([
    ["dismissed", { action: "dismiss" as const }],
    ["declined", { action: "submit" as const, decision: "Decline" as const }],
  ])("does not run a %s call", async (_name, response) => {
    const { approval } = await askInRoot();

    await answer({
      ...response,
      itemId: approval.reviewItemId,
      user: aliceUser,
    });

    await expect(
      wireRun(runContext({ turnId: "turn-2" })).runApproved(),
    ).resolves.toEqual([]);
    expect(executions).toEqual([]);
    expect(await onlyApproval(rootId)).toMatchObject({ decision: "deny" });
  });

  it("runs a Slack ask once, as the approver, in the Turn that their web answer starts", async () => {
    await getStateAdapter().connect();
    // Alice asks in Slack, so the call has her Slack Actor and credentials.
    await wireRun(
      runContext({ credentialContext: credentialContextForActor(alice) }),
    ).call("call-1", { id: "r-1" });
    const approval = await onlyApproval(rootId);

    // She approves on the review desk. The answer reaches the Slack thread
    // as her web message, so the Turn it starts has her web Actor.
    await answer({
      action: "submit",
      itemId: approval.reviewItemId,
      queue: createConversationWorkQueueTestAdapter(),
      user: aliceUser,
    });
    const pending =
      (await getConversation({ conversationId: rootId }))?.execution
        .pendingMessages ?? [];
    expect(pending.map((message) => message.input.authorId)).toEqual([
      aliceUser.id,
    ]);
    const web = webActorFromUser(aliceUser);
    const answerTurn = runContext({
      actor: web,
      credentialContext: credentialContextForActor(web),
      turnId: "turn-2",
    });

    await expect(wireRun(answerTurn).runApproved()).resolves.toHaveLength(1);
    await expect(
      wireRun({ ...answerTurn, turnId: "turn-3" }).runApproved(),
    ).resolves.toEqual([]);
    expect(executions).toEqual([{ id: "r-1" }]);
  });

  it("does not run a call on an answer from someone who is not the approver", async () => {
    const bob = await linkSlackUser("bob@example.com", "U456");
    const { approval } = await askInRoot();

    await expect(
      answer({ action: "submit", itemId: approval.reviewItemId, user: bob }),
    ).rejects.toThrow(ReviewItemActionError);
    // Bob's own Turn does not run Alice's call either.
    await expect(
      wireRun(
        runContext({ actor: { ...alice, userId: "U456" }, turnId: "turn-2" }),
      ).runApproved(),
    ).resolves.toEqual([]);

    expect(executions).toEqual([]);
    expect(await onlyApproval(rootId)).not.toHaveProperty("decision");
    await expect(
      getReviewItem(getDb(), approval.reviewItemId),
    ).resolves.toMatchObject({ status: "open" });

    // Bob's identical call gets its own item, which only Bob can answer.
    await wireRun(
      runContext({ actor: { ...alice, userId: "U456" }, turnId: "turn-3" }),
    ).call("call-2", { id: "r-1" });
    const bobs = (await listToolApprovals(rootId)).find(
      (candidate) => candidate.toolCallId === "call-2",
    );
    expect(bobs?.reviewItemId).not.toBe(approval.reviewItemId);
    await expect(
      getReviewItem(getDb(), bobs!.reviewItemId),
    ).resolves.toMatchObject({
      assignees: [expect.objectContaining({ userId: bob.id })],
    });
  });

  it("expires an approval that waits too long, and then never runs it", async () => {
    const { approval } = await askInRoot();
    vi.useFakeTimers({
      now: Date.now() + 25 * 60 * 60 * 1_000,
      toFake: ["Date"],
    });
    try {
      await expect(
        wireRun(runContext({ turnId: "turn-2" })).runApproved(),
      ).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }

    expect(executions).toEqual([]);
    expect(await onlyApproval(rootId)).toMatchObject({ decision: "deny" });
    await expect(
      getReviewItem(getDb(), approval.reviewItemId),
    ).resolves.toMatchObject({ status: "dismissed" });
  });

  it("denies an ask in an Automation run, where no person can answer", async () => {
    const source: Source = { kind: "scheduled_automation" };
    const run = wireRun(runContext({ source }));

    const result = await run.call("call-1", { id: "r-1" });

    expect(result.allowed ? undefined : result.error.message).toContain(
      "No person can approve this action",
    );
    expect(await listToolApprovals(rootId)).toEqual([]);
    expect(executions).toEqual([]);
  });

  it("denies an ask whose input is too long to show the person in full", async () => {
    const run = wireRun(runContext());

    const result = await run.call("call-1", { id: "r".repeat(3_000) });

    expect(result.allowed ? undefined : result.error.message).toContain(
      "too long to show a person in full",
    );
    expect(await listToolApprovals(rootId)).toEqual([]);
    expect(executions).toEqual([]);
  });

  it("files a child agent's ask on the root's review desk and runs it in the child", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    // The child agent runs as the root's person.
    const { childConversationId: childId } =
      await createAndEnqueueAgentInvocation(
        { ...slackInvocationInput, actor: alice, idempotencyKey: "child" },
        { conversationStore, queue, state },
      );
    queue.takeMessageFor(childId);
    const child = runContext({
      conversationId: childId,
      source: { kind: "agent_invocation" },
    });

    await wireRun(child).call("call-1", { id: "r-1" });

    const approval = await onlyApproval(childId);
    await expect(
      getReviewItem(getDb(), approval.reviewItemId),
    ).resolves.toMatchObject({
      addedByConversationId: rootId,
      assignees: [expect.objectContaining({ userId: aliceUser.id })],
      conversationIds: [rootId],
    });
    await expect(
      listWaitingConversations(getDb(), aliceUser.id),
    ).resolves.toEqual([
      expect.objectContaining({
        conversationId: rootId,
        items: [{ plugin: "junior", title: `Approve ${TOOL}?` }],
      }),
    ]);

    await answer({
      action: "submit",
      itemId: approval.reviewItemId,
      queue,
      user: aliceUser,
    });

    // The answer wakes the child, and only the child's Run runs the call.
    expect(
      queue
        .queuedMessages()
        .map((message) => message.conversationId)
        .filter((id) => id === childId),
    ).toHaveLength(1);
    await expect(wireRun(runContext()).runApproved()).resolves.toEqual([]);
    await expect(
      wireRun({ ...child, turnId: "child-turn-2" }).runApproved(),
    ).resolves.toHaveLength(1);
    expect(executions).toEqual([{ id: "r-1" }]);
  });
});
