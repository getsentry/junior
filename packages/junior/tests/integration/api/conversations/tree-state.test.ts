import { afterEach, describe, expect, it } from "vitest";
import {
  conversationDetailReportSchema,
  conversationFeedSchema,
} from "@/api/schema";
import { getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { closeReviewItem, insertReviewItem } from "@/chat/review-items/store";
import { recordAuthorizationRequested } from "@/chat/conversations/projection";
import { cancelWatch, createTimerWatch } from "@/chat/events/store";
import {
  spawnChildAgent,
  startRunningChildAgent,
} from "../../../fixtures/agent-invocations";
import { expectSqlBudget } from "../../../fixtures/sql-budget";
import { closeConversationFixture } from "../../../fixtures/conversation";
import {
  SLACK_VIEWER,
  SLACK_DESTINATION,
  REQUEST,
  ACTION_ITEM,
  detailPath,
  createStatusFixture,
  recordSlackRoot,
  recordDashboardRoot,
  recordAnswer,
  addItem,
  watchDeployment,
  DONE,
} from "../../../fixtures/conversation-status";

describe("conversation tree state", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("orders needs_you over working over watching across the whole tree", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000400",
    );
    await expect(fixture.tree(conversationId)).resolves.toEqual(DONE);

    await watchDeployment(conversationId);
    await expect(fixture.tree(conversationId)).resolves.toEqual({
      treeState: "done",
      watching: true,
    });

    const args = {
      conversationStore: fixture.conversationStore,
      destination: SLACK_DESTINATION,
      parentConversationId: conversationId,
      queue: fixture.queue,
      state: fixture.state,
    };
    const running = await startRunningChildAgent({
      ...args,
      idempotencyKey: "tree-running-child",
    });
    // The parent's own status stays done; its tree works.
    await expect(fixture.status(conversationId)).resolves.toBe("done");
    await expect(fixture.tree(conversationId)).resolves.toEqual({
      treeState: "working",
      watching: true,
    });
    await expect(
      fixture.tree(running.invocation.childConversationId),
    ).resolves.toEqual({ treeState: "working", watching: false });

    const asking = await spawnChildAgent({
      ...args,
      idempotencyKey: "tree-asking-child",
    });
    fixture.queue.takeMessageFor(asking.childConversationId);
    // An item for another person is not shown to the viewer.
    const other = await resolveViewerUser("bob@example.com");
    const forOther = await insertReviewItem(getDb(), {
      addedByConversationId: asking.childConversationId,
      assignedToEveryone: false,
      assigneeUserIds: [other!.id],
      body: "Bob decides.",
      conversationIds: [asking.childConversationId],
      dedupeKey: "for-other",
      kind: "action",
      nowMs: Date.now(),
      request: REQUEST,
      title: "Bob's call",
      visibility: "public",
    });
    await expect(fixture.status(asking.childConversationId)).resolves.toBe(
      "needs_input",
    );
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "working",
    });
    await closeReviewItem(getDb(), {
      id: forOther!.id,
      nowMs: Date.now(),
      status: "dismissed",
    });

    // An item for Everyone needs the viewer too.
    const everyone = await addItem(asking.childConversationId, {
      ...ACTION_ITEM,
      assignees: ["everyone"],
    });
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_you",
    });
    await closeReviewItem(getDb(), {
      id: everyone,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "working",
    });

    const item = await addItem(asking.childConversationId, ACTION_ITEM);
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_you",
    });
    await expect(fixture.feedTree(conversationId)).resolves.toMatchObject({
      treeState: "needs_you",
    });
    await expect(fixture.tree(asking.childConversationId)).resolves.toEqual({
      treeState: "needs_you",
      watching: false,
    });

    await closeReviewItem(getDb(), {
      id: item,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.feedTree(conversationId)).resolves.toEqual({
      treeState: "working",
      watching: true,
    });
  });

  it("rolls a grandchild up to its root and parent, not to a sibling", async () => {
    const fixture = await createStatusFixture();
    const rootId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000450",
    );
    const otherRootId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000460",
    );
    const args = {
      conversationStore: fixture.conversationStore,
      destination: SLACK_DESTINATION,
      queue: fixture.queue,
      state: fixture.state,
    };
    const parent = await spawnChildAgent({
      ...args,
      parentConversationId: rootId,
      idempotencyKey: "tree-depth-parent",
    });
    const sibling = await spawnChildAgent({
      ...args,
      parentConversationId: rootId,
      idempotencyKey: "tree-depth-sibling",
    });
    const grandchild = await spawnChildAgent({
      ...args,
      parentConversationId: parent.childConversationId,
      idempotencyKey: "tree-depth-grandchild",
    });
    for (const child of [parent, sibling, grandchild]) {
      fixture.queue.takeMessageFor(child.childConversationId);
    }

    await addItem(grandchild.childConversationId, ACTION_ITEM);

    await expect(fixture.feedTree(rootId)).resolves.toMatchObject({
      treeState: "needs_you",
    });
    await expect(fixture.tree(rootId)).resolves.toMatchObject({
      treeState: "needs_you",
    });
    await expect(fixture.tree(parent.childConversationId)).resolves.toEqual({
      treeState: "needs_you",
      watching: false,
    });
    // The sibling's own spawned Turn still waits in the queue.
    await expect(fixture.tree(sibling.childConversationId)).resolves.toEqual({
      treeState: "working",
      watching: false,
    });
    await expect(fixture.feedTree(otherRootId)).resolves.toEqual(DONE);
  });

  it("needs the viewer for their own sign-in waits anywhere in the tree", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000450",
    );
    const childConversationId = "agent:tree-sign-in-child";
    await fixture.conversationStore.createChild({
      childConversationId,
      kind: "task",
      parentConversationId: conversationId,
    });
    const signIn = (actorId: string, authorizationId: string) =>
      recordAuthorizationRequested({
        actorId,
        authorizationId,
        conversationId: childConversationId,
        delivery: "private_link_sent",
        kind: "mcp",
        provider: "notion",
      });
    await signIn("UBOB", "tree-sign-in-bob");
    await expect(fixture.status(childConversationId)).resolves.toBe(
      "needs_input",
    );
    await expect(fixture.tree(conversationId)).resolves.toEqual(DONE);
    // The request names the viewer by their Slack user id.
    await signIn(SLACK_VIEWER.slackUserId, "tree-sign-in-viewer");
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_you",
    });
  });

  it("needs the starter only for the Conversation's own wait on them", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordDashboardRoot(
      fixture.conversationStore,
      "local:web:tree-answer",
    );
    const threadId = "agent:tree-answer-thread";
    await fixture.conversationStore.createChild({
      childConversationId: threadId,
      kind: "thread",
      parentConversationId: conversationId,
    });
    // A Thread's unread answer waits on the starter in the Thread only.
    await recordAnswer(threadId, 1);
    await expect(fixture.tree(threadId)).resolves.toMatchObject({
      treeState: "needs_you",
    });
    await expect(fixture.tree(conversationId)).resolves.toEqual(DONE);
    await recordAnswer(conversationId, 1);
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_you",
    });

    // An answer that another person has not read is not shown.
    const other = await recordDashboardRoot(
      fixture.conversationStore,
      "local:web:tree-answer-bob",
      { email: "bob@example.com", slackUserId: "UBOB", teamId: "TSTATUS" },
    );
    await recordAnswer(other, 1);
    await expect(fixture.status(other)).resolves.toBe("needs_input");
    await expect(fixture.tree(other)).resolves.toEqual(DONE);
  });

  it("watches while a pending Timer alone waits, until it ends", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000500",
    );
    const childConversationId = "agent:tree-timer-child";
    await fixture.conversationStore.createChild({
      childConversationId,
      kind: "task",
      parentConversationId: conversationId,
      title: "Check the deployment later",
    });
    const timer = await createTimerWatch({
      afterMs: 600_000,
      conversationId: childConversationId,
      intent: "Check the deployment.",
      toolCallId: "tree-timer",
    });
    const watching = { treeState: "done", watching: true };
    // A Timer is not work, so the shared status stays done.
    await expect(fixture.status(childConversationId)).resolves.toBe("done");
    await expect(fixture.tree(conversationId)).resolves.toEqual(watching);
    await expect(fixture.feedTree(conversationId)).resolves.toEqual(watching);
    await expect(fixture.tree(childConversationId)).resolves.toEqual(watching);

    await cancelWatch({ conversationId: childConversationId, id: timer.id });
    await expect(fixture.tree(conversationId)).resolves.toEqual(DONE);

    // A stop in the tree ends its Watches, so the feed token moves.
    await createTimerWatch({
      afterMs: 600_000,
      conversationId: childConversationId,
      intent: "Check the deployment again.",
      toolCallId: "tree-timer-again",
    });
    const feedToken = async () => {
      const response = await fixture.request("/api/versions");
      return ((await response.json()) as { conversations: string })
        .conversations;
    };
    const beforeStop = await feedToken();
    const childStopped = await fixture.request(
      `${detailPath(childConversationId)}/stop`,
      { method: "POST" },
    );
    expect(childStopped.status).toBe(200);
    await expect(fixture.feedTree(conversationId)).resolves.toEqual(DONE);
    expect(await feedToken()).not.toBe(beforeStop);

    // A stopped Conversation starts no Turn for its Watches.
    await watchDeployment(conversationId);
    await expect(fixture.tree(conversationId)).resolves.toEqual(watching);
    const stopped = await fixture.request(
      `${detailPath(conversationId)}/stop`,
      { method: "POST" },
    );
    expect(stopped.status).toBe(200);
    await expect(fixture.tree(conversationId)).resolves.toEqual(DONE);
  });

  it("reads the tree state of a feed page and a detail in one statement", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000600",
    );
    await recordSlackRoot(fixture.conversationStore, "1700000000.000700");
    const addChildren = async (childIds: string[]) => {
      for (const childConversationId of childIds) {
        await fixture.conversationStore.createChild({
          childConversationId,
          kind: "task",
          parentConversationId: conversationId,
        });
      }
    };
    // The feed and the detail keep one budget however big the tree grows.
    const expectBudget = async (tree: {
      treeState: string;
      watching: boolean;
    }) => {
      const feed = await expectSqlBudget(
        () => fixture.request("/api/conversations"),
        { statements: 20, serialRounds: 5 },
      );
      const row = conversationFeedSchema
        .parse(await feed.json())
        .conversations.find((row) => row.conversationId === conversationId);
      expect({ treeState: row?.treeState, watching: row?.watching }).toEqual(
        tree,
      );
      const detail = await expectSqlBudget(
        () => fixture.request(detailPath(conversationId)),
        { statements: 20, serialRounds: 5 },
      );
      const report = conversationDetailReportSchema.parse(await detail.json());
      expect({
        treeState: report.treeState,
        watching: report.watching,
      }).toEqual(tree);
    };

    await addChildren(["agent:tree-budget-a"]);
    await watchDeployment("agent:tree-budget-a");
    await expectBudget({ treeState: "done", watching: true });
    await addChildren([
      "agent:tree-budget-b",
      "agent:tree-budget-c",
      "agent:tree-budget-d",
    ]);
    await addItem("agent:tree-budget-d", ACTION_ITEM);
    await expectBudget({ treeState: "needs_you", watching: true });
  });
});
