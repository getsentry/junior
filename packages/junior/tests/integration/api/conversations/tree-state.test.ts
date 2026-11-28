import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { setConversationArchive } from "@/api/conversations/archive";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  conversationDetailReportSchema,
  conversationFeedSchema,
  spaceListSchema,
} from "@/api/schema";
import { getSpaceLead } from "@/chat/lead/conversation";
import { createSpace } from "@/chat/spaces/store";
import { Hono } from "hono";
import { getDb } from "@/chat/db";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { closeInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { recordAuthorizationRequested } from "@/chat/conversations/projection";
import { cancelWatch, createTimerWatch } from "@/chat/events/store";
import {
  spawnChildAgent,
  startRunningChildAgent,
} from "../../../fixtures/child-agents";
import {
  expectNoInboxSql,
  expectSqlBudget,
} from "../../../fixtures/sql-budget";
import {
  closeConversationFixture,
  webTestActor,
} from "../../../fixtures/conversation";
import {
  SLACK_VIEWER,
  SLACK_DESTINATION,
  failingAgentRunner,
  REQUEST,
  ACTION_ITEM,
  detailPath,
  createStatusFixture,
  recordSlackRoot,
  recordDashboardRoot,
  recordAnswer,
  lastSeq,
  addItem,
  watchDeployment,
  DONE,
} from "../../../fixtures/conversation-status";

type StatusFixture = Awaited<ReturnType<typeof createStatusFixture>>;

/** Read the viewer's feed version token. */
async function feedToken(fixture: StatusFixture): Promise<string> {
  const response = await fixture.request("/api/versions");
  return ((await response.json()) as { conversations: string }).conversations;
}

describe("conversation tree state", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("orders needs_input over working over watching across the whole tree", async () => {
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
      fixture.tree(running.child.childConversationId),
    ).resolves.toEqual({ treeState: "working", watching: false });

    const asking = await spawnChildAgent({
      ...args,
      idempotencyKey: "tree-asking-child",
    });
    fixture.queue.takeMessageFor(asking.childConversationId);
    // An item for another person is not shown to the viewer.
    const other = await resolveViewerUser("bob@example.com");
    const forOther = await insertInboxItem(getDb(), {
      subject: { id: "for-other", kind: "question" },
      owner: { id: asking.childConversationId, kind: "conversation" },
      assignedToEveryone: false,
      assigneeUserIds: [other!.id],
      body: "Bob decides.",
      conversationIds: [asking.childConversationId],
      kind: "action",
      nowMs: Date.now(),
      request: REQUEST,
      title: "Bob's call",
    });
    await expect(fixture.status(asking.childConversationId)).resolves.toBe(
      "needs_input",
    );
    // A waiting question shows to every viewer, whoever it asks.
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_input",
    });
    await closeInboxItem(getDb(), {
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
      treeState: "needs_input",
    });
    await closeInboxItem(getDb(), {
      id: everyone,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "working",
    });

    const item = await addItem(asking.childConversationId, ACTION_ITEM);
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_input",
    });
    await expect(fixture.feedTree(conversationId)).resolves.toMatchObject({
      treeState: "needs_input",
    });
    await expect(fixture.tree(asking.childConversationId)).resolves.toEqual({
      treeState: "needs_input",
      watching: false,
    });

    await closeInboxItem(getDb(), {
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
      treeState: "needs_input",
    });
    await expect(fixture.tree(rootId)).resolves.toMatchObject({
      treeState: "needs_input",
    });
    await expect(fixture.tree(parent.childConversationId)).resolves.toEqual({
      treeState: "needs_input",
      watching: false,
    });
    // The sibling's own spawned Turn still waits in the queue.
    await expect(fixture.tree(sibling.childConversationId)).resolves.toEqual({
      treeState: "working",
      watching: false,
    });
    await expect(fixture.feedTree(otherRootId)).resolves.toEqual(DONE);
  });

  it("gives each Thread in the feed its own tree state", async () => {
    const fixture = await createStatusFixture();
    const rootId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000470",
    );
    for (const childConversationId of ["agent:feed-ask", "agent:feed-done"]) {
      await fixture.conversationStore.createChild({
        childConversationId,
        kind: "thread",
        parentConversationId: rootId,
      });
    }

    await addItem("agent:feed-ask", ACTION_ITEM);

    const row = await fixture.feedRow(rootId);
    // The sidebar orders a root's Threads by these, as the Threads panel
    // orders a Conversation's children.
    expect(
      Object.fromEntries(
        (row?.threads ?? []).map((thread) => [
          thread.conversationId,
          { treeState: thread.treeState, watching: thread.watching },
        ]),
      ),
    ).toEqual({
      "agent:feed-ask": { treeState: "needs_input", watching: false },
      "agent:feed-done": DONE,
    });
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
      treeState: "needs_input",
    });
  });

  it("needs the starter for a wait on them anywhere in the tree", async () => {
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
    // A Thread's unread answer waits on the starter, so its parent needs
    // them too, until they read it.
    await recordAnswer(threadId, 1);
    await expect(fixture.tree(threadId)).resolves.toMatchObject({
      treeState: "needs_input",
    });
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_input",
    });
    const read = await fixture.request(
      `${detailPath(threadId)}/read-position`,
      {
        body: JSON.stringify({ lastReadSeq: await lastSeq(threadId) }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(read.status).toBe(200);
    await expect(fixture.tree(conversationId)).resolves.toEqual(DONE);
    await recordAnswer(conversationId, 1);
    await expect(fixture.tree(conversationId)).resolves.toMatchObject({
      treeState: "needs_input",
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
    const beforeStop = await feedToken(fixture);
    const childStopped = await fixture.request(
      `${detailPath(childConversationId)}/stop`,
      { method: "POST" },
    );
    expect(childStopped.status).toBe(200);
    await expect(fixture.feedTree(conversationId)).resolves.toEqual(DONE);
    expect(await feedToken(fixture)).not.toBe(beforeStop);

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

  it("skips archived children and their descendants", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000550",
    );
    const childConversationId = "agent:tree-archived-child";
    const grandchildConversationId = "agent:tree-archived-grandchild";
    await fixture.conversationStore.createChild({
      childConversationId,
      kind: "thread",
      parentConversationId: conversationId,
    });
    await fixture.conversationStore.createChild({
      childConversationId: grandchildConversationId,
      kind: "task",
      parentConversationId: childConversationId,
    });
    await addItem(grandchildConversationId, ACTION_ITEM);
    await watchDeployment(childConversationId);
    const needsYou = { treeState: "needs_input", watching: true };
    await expect(fixture.tree(conversationId)).resolves.toEqual(needsYou);

    const [child] = await getDb()
      .select({ lastActivityAt: juniorConversations.lastActivityAt })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, childConversationId));
    await expect(
      setConversationArchive({
        applyToChildren: true,
        archived: true,
        conversationId: childConversationId,
        lastSeenAt: child!.lastActivityAt.toISOString(),
      }),
    ).resolves.toMatchObject({ status: "archived" });
    await expect(fixture.tree(conversationId)).resolves.toEqual(DONE);
    await expect(fixture.feedTree(conversationId)).resolves.toEqual(DONE);
    // An archived Conversation still counts for itself.
    await expect(fixture.tree(childConversationId)).resolves.toEqual({
      treeState: "done",
      watching: true,
    });
  });

  it("moves the feed token when the root's wait on the viewer starts and ends", async () => {
    const fixture = await createStatusFixture();
    // A Slack root's reply that Slack did not show adds no reply notice.
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000590",
    );
    // Bob's sign-in is a wait that the viewer does not see.
    await recordAuthorizationRequested({
      actorId: "UBOB",
      authorizationId: "token-sign-in-bob",
      conversationId,
      delivery: "private_link_sent",
      kind: "mcp",
      provider: "notion",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await expect(fixture.feedTree(conversationId)).resolves.toEqual(DONE);
    const before = await feedToken(fixture);

    // The status still reads `needs_input`; only the viewer's wait moves.
    await recordAnswer(conversationId, 1);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await expect(fixture.feedTree(conversationId)).resolves.toMatchObject({
      treeState: "needs_input",
    });
    const waiting = await feedToken(fixture);
    expect(waiting).not.toBe(before);

    // The starter's read ends the wait, and the status still reads
    // `needs_input` for Bob.
    const read = await fixture.request(
      `${detailPath(conversationId)}/read-position`,
      {
        body: JSON.stringify({ lastReadSeq: await lastSeq(conversationId) }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(read.status).toBe(200);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await expect(fixture.feedTree(conversationId)).resolves.toEqual(DONE);
    expect(await feedToken(fixture)).not.toBe(waiting);
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
        () => expectNoInboxSql(() => fixture.request("/api/conversations")),
        { statements: 17, serialRounds: 3 },
      );
      const row = conversationFeedSchema
        .parse(await feed.json())
        .conversations.find((row) => row.conversationId === conversationId);
      expect({ treeState: row?.treeState, watching: row?.watching }).toEqual(
        tree,
      );
      const detail = await expectSqlBudget(
        () =>
          expectNoInboxSql(() => fixture.request(detailPath(conversationId))),
        { statements: 19, serialRounds: 5 },
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
    await expectBudget({ treeState: "needs_input", watching: true });
  });

  it("rolls up a Space's Conversations into its Space list row", async () => {
    const fixture = await createStatusFixture(failingAgentRunner);
    const viewer = await resolveViewerUser(webTestActor.email);
    const space = await createSpace({
      creator: viewer!,
      description: null,
      name: "Release",
      visibility: "public",
    });
    // Bob is a member who did not start the work.
    const bob = await resolveViewerUser("bob@example.com");
    const bobApp = new Hono<JuniorApiEnv>();
    bobApp.use("*", async (context, next) => {
      context.set("viewer", bob!);
      await next();
    });
    bobApp.route(
      "/",
      createJuniorApi({ conversationWorkQueue: fixture.queue }),
    );
    // A Space's members are the Participants of its Lead.
    const lead = await getSpaceLead(space.id);
    await getDb().insert(juniorConversationParticipants).values({
      lastMessageAt: new Date(),
      rootConversationId: lead.conversationId,
      userId: bob!.id,
    });
    const spaceRow = async (request: (path: string) => Promise<Response>) => {
      const response = await request("/api/spaces");
      expect(response.status).toBe(200);
      const row = spaceListSchema
        .parse(await response.json())
        .spaces.find((listed) => listed.id === space.id);
      return {
        latestTurnFailed: row?.latestTurnFailed,
        treeState: row?.treeState,
      };
    };
    // The Space list reads no Inbox table.
    const asViewer = () =>
      expectNoInboxSql(() => spaceRow((path) => fixture.request(path)));
    const asBob = () =>
      spaceRow(async (path) => await bobApp.request(`http://localhost${path}`));
    const idle = { latestTurnFailed: false, treeState: "done" };
    await expect(asViewer()).resolves.toEqual(idle);

    const started = await fixture.request("/api/conversations", {
      body: JSON.stringify({
        idempotencyKey: "space-roll-up",
        message: "Check the release.",
        spaceId: space.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(started.status).toBe(200);
    const { conversationId } = acceptedConversationMessageSchema.parse(
      await started.json(),
    );
    await fixture.start("space-roll-up-one-off");
    await expect(asViewer()).resolves.toEqual({
      latestTurnFailed: false,
      treeState: "working",
    });

    await fixture.drain();
    // The failed Turn waits on its starter, so it needs the viewer. Bob
    // sees that it failed.
    await expect(asViewer()).resolves.toEqual({
      latestTurnFailed: true,
      treeState: "needs_input",
    });
    // The failure starts a Turn of the Lead, which Bob sees as working.
    await expect(asBob()).resolves.toEqual({
      latestTurnFailed: true,
      treeState: "working",
    });

    const [row] = await getDb()
      .select({ lastActivityAt: juniorConversations.lastActivityAt })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, conversationId));
    await setConversationArchive({
      applyToChildren: false,
      archived: true,
      conversationId,
      lastSeenAt: row!.lastActivityAt.toISOString(),
    });
    // An archived Conversation counts for nothing, and the one-off, which
    // failed too, counts for no Space. The Lead's Turn for the failure
    // still waits to run.
    const leadWorking = { latestTurnFailed: false, treeState: "working" };
    await expect(asViewer()).resolves.toEqual(leadWorking);
    await expect(asBob()).resolves.toEqual(leadWorking);
  });
});
