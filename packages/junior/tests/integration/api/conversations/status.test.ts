import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  conversationDetailReportSchema,
} from "@/api/schema";
import { getDb } from "@/chat/db";
import { closeInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { recordAuthorizationRequested } from "@/chat/conversations/projection";
import { juniorConversations, juniorInboxItems } from "@/db/schema";
import {
  spawnChildAgent,
  startRunningChildAgent,
} from "../../../fixtures/agent-invocations";
import {
  closeConversationFixture,
  webTestActor,
} from "../../../fixtures/conversation";
import {
  SLACK_VIEWER,
  SLACK_DESTINATION,
  REQUEST,
  ACTION_ITEM,
  failingAgentRunner,
  lastSeq,
  recordStarterMessage,
  detailPath,
  createStatusFixture,
  recordSlackRoot,
  recordDashboardRoot,
  recordAnswer,
  addItem,
} from "../../../fixtures/conversation-status";

describe("conversation status", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("works while input waits, needs input after its Turn fails, and works again for new input", async () => {
    const fixture = await createStatusFixture(failingAgentRunner);
    const conversationId = await fixture.start("status-failed");
    await expect(fixture.status(conversationId)).resolves.toBe("working");

    await fixture.drain();
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    // The feed reads the same status as the detail, and says the Turn
    // failed.
    await expect(fixture.feedRow(conversationId)).resolves.toMatchObject({
      latestTurnFailed: true,
      status: "needs_input",
    });

    // A failure does not hold input.
    await expect(
      fixture.send(conversationId, "status-failed-retry"),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(fixture.status(conversationId)).resolves.toBe("working");
  });

  it("needs input while an open action item that it added is open", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000100",
    );
    await addItem(conversationId, {
      kind: "notice",
      title: "Release shipped",
      body: "No action needed.",
      assignees: [webTestActor.email],
    });
    await expect(fixture.status(conversationId)).resolves.toBe("done");
    const before = await fixture.request(detailPath(conversationId));
    const version = before.headers.get(CONVERSATION_DETAIL_VERSION_HEADER);
    expect(version).toBeTruthy();

    // addInboxItem assigns a Participant by default. A Slack Actor without
    // a User adds an item that no one is assigned to, and anyone in the
    // thread can answer it.
    const unassigned = await insertInboxItem(getDb(), {
      owner: { id: conversationId, kind: "conversation" },
      assignedToEveryone: false,
      assigneeUserIds: [],
      body: "Anyone in the thread can answer.",
      conversationIds: [conversationId],
      dedupeKey: "unassigned",
      kind: "action",
      nowMs: Date.now(),
      request: REQUEST,
      title: "Pick a release name",
      visibility: "public",
    });
    // Only the item changed, and a poll with the old version reloads.
    const polled = await fixture.request(detailPath(conversationId), {
      headers: { [CONVERSATION_DETAIL_VERSION_HEADER]: version! },
    });
    expect(polled.status).toBe(200);
    expect(
      conversationDetailReportSchema.parse(await polled.json()).status,
    ).toBe("needs_input");
    await closeInboxItem(getDb(), {
      id: unassigned!.id,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("done");

    const everyone = await addItem(conversationId, {
      ...ACTION_ITEM,
      assignees: ["everyone"],
    });
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await closeInboxItem(getDb(), {
      id: everyone,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("done");

    const assigned = await addItem(conversationId, ACTION_ITEM);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    // The person's answer is input for a new Turn.
    const answered = await fixture.request(
      `/api/inbox-items/${assigned}/actions`,
      {
        body: JSON.stringify({
          action: "submit",
          answer: { values: { decision: ["Ship"] } },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(answered.status).toBe(200);
    await expect(fixture.status(conversationId)).resolves.toBe("working");
  });

  it("needs input while a Turn waits on a person to sign in", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000150",
    );
    await expect(fixture.status(conversationId)).resolves.toBe("done");
    await recordAuthorizationRequested({
      actorId: SLACK_VIEWER.slackUserId,
      authorizationId: "status-sign-in",
      conversationId,
      delivery: "private_link_sent",
      kind: "mcp",
      provider: "notion",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
  });

  it("dates a sign-in wait with the app clock, not the database clock", async () => {
    // The app clock dates the request, so a clock behind the database's
    // must still see the wait.
    vi.useFakeTimers({
      now: Date.now() - 30 * 24 * 60 * 60 * 1000,
      toFake: ["Date"],
    });
    try {
      const fixture = await createStatusFixture();
      const conversationId = await recordSlackRoot(
        fixture.conversationStore,
        "1700000000.000155",
      );
      await recordAuthorizationRequested({
        actorId: SLACK_VIEWER.slackUserId,
        authorizationId: "status-sign-in-clock",
        conversationId,
        delivery: "private_link_sent",
        kind: "mcp",
        provider: "notion",
      });
      await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders needs_input over working over done, and a stop ends the wait", async () => {
    const fixture = await createStatusFixture(failingAgentRunner);
    const conversationId = await fixture.start("status-precedence");
    const item = await addItem(conversationId, ACTION_ITEM);
    // The queued Turn still reads as active, so live views keep polling.
    await expect(fixture.detail(conversationId)).resolves.toMatchObject({
      status: "needs_input",
      turnActive: true,
    });
    await expect(fixture.feedTurnActive(conversationId)).resolves.toBe(true);
    await closeInboxItem(getDb(), {
      id: item,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("working");

    await fixture.drain();
    await expect(fixture.detail(conversationId)).resolves.toMatchObject({
      status: "needs_input",
      turnActive: false,
    });

    const stopped = await fixture.request(
      `${detailPath(conversationId)}/stop`,
      {
        method: "POST",
      },
    );
    expect(stopped.status).toBe(200);
    await expect(fixture.status(conversationId)).resolves.toBe("done");
  });

  it("waits on the starter until they read an answer", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordDashboardRoot(
      fixture.conversationStore,
      "local:web:status-answer",
    );
    await expect(fixture.status(conversationId)).resolves.toBe("done");
    await recordAnswer(conversationId, 1);
    // A dashboard answer waits until the starter reads it.
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    const before = await fixture.request(detailPath(conversationId));
    const version = before.headers.get(CONVERSATION_DETAIL_VERSION_HEADER);
    expect(version).toBeTruthy();
    const read = await fixture.request(
      `${detailPath(conversationId)}/read-position`,
      {
        body: JSON.stringify({ lastReadSeq: await lastSeq(conversationId) }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(read.status).toBe(200);
    // The read ends the wait, so a poll with the old version reloads.
    const polled = await fixture.request(detailPath(conversationId), {
      headers: { [CONVERSATION_DETAIL_VERSION_HEADER]: version! },
    });
    expect(polled.status).toBe(200);
    expect(
      conversationDetailReportSchema.parse(await polled.json()).status,
    ).toBe("done");

    // A later Message from the starter also reads it.
    await recordAnswer(conversationId, 2);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await recordStarterMessage(conversationId);
    await expect(fixture.status(conversationId)).resolves.toBe("done");
  });

  it("finds the latest answer by transcript order, not by time", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordDashboardRoot(
      fixture.conversationStore,
      "local:web:status-answer-order",
    );
    await recordAnswer(conversationId, 1);
    const firstSeq = await lastSeq(conversationId);
    // A later answer can carry an earlier time.
    await recordAnswer(conversationId, 2, Date.now() - 60_000);
    const read = await fixture.request(
      `${detailPath(conversationId)}/read-position`,
      {
        body: JSON.stringify({ lastReadSeq: firstSeq }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(read.status).toBe(200);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
  });

  it("counts an answer that Slack accepted as read", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000250",
    );
    await recordAnswer(conversationId, 1, Date.now(), "slack");
    await expect(fixture.status(conversationId)).resolves.toBe("done");
    // A paused root keeps its reply out of Slack, so the starter must read it.
    await recordAnswer(conversationId, 2);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
  });

  it("counts an old answer with no source as sent to Slack", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000260",
    );
    // Delivery pauses did not exist yet, so the answer reached Slack.
    await recordAnswer(
      conversationId,
      1,
      Date.parse("2026-08-01T00:00:00.000Z"),
    );
    await expect(fixture.status(conversationId)).resolves.toBe("done");
  });

  it("does not wait on a read when the root has no starter", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordDashboardRoot(
      fixture.conversationStore,
      "local:web:status-no-starter",
    );
    await getDb()
      .update(juniorConversations)
      .set({ actorIdentityId: null })
      .where(eq(juniorConversations.conversationId, conversationId));
    await recordAnswer(conversationId, 1);
    await expect(fixture.status(conversationId)).resolves.toBe("done");
  });

  it("covers only the Conversation's own work, not its child agents", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000200",
    );
    const args = {
      conversationStore: fixture.conversationStore,
      destination: SLACK_DESTINATION,
      parentConversationId: conversationId,
      queue: fixture.queue,
      state: fixture.state,
    };
    const running = await startRunningChildAgent({
      ...args,
      idempotencyKey: "status-running-child",
    });
    const asking = await spawnChildAgent({
      ...args,
      idempotencyKey: "status-asking-child",
    });
    fixture.queue.takeMessageFor(asking.childConversationId);
    await addItem(asking.childConversationId, ACTION_ITEM);

    await expect(fixture.status(conversationId)).resolves.toBe("done");
    await expect(
      fixture.status(running.child.childConversationId),
    ).resolves.toBe("working");
    await expect(fixture.status(asking.childConversationId)).resolves.toBe(
      "needs_input",
    );
    // A Task returns its answer to its parent, so nobody reads it.
    const answered = await spawnChildAgent({
      ...args,
      idempotencyKey: "status-answered-child",
    });
    fixture.queue.takeMessageFor(answered.childConversationId);
    await getDb()
      .update(juniorConversations)
      .set({ executionStatus: "idle" })
      .where(
        eq(juniorConversations.conversationId, answered.childConversationId),
      );
    await recordAnswer(answered.childConversationId, 1);
    await expect(fixture.status(answered.childConversationId)).resolves.toBe(
      "done",
    );
    // A Task stored before `kind` existed is still a Task.
    await getDb()
      .update(juniorConversations)
      .set({ kind: null })
      .where(
        eq(juniorConversations.conversationId, answered.childConversationId),
      );
    await expect(fixture.status(answered.childConversationId)).resolves.toBe(
      "done",
    );
  });

  it("keeps the status of an archived Conversation", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000300",
    );
    await addItem(conversationId, ACTION_ITEM);
    const detail = conversationDetailReportSchema.parse(
      await (await fixture.request(detailPath(conversationId))).json(),
    );

    const archived = await fixture.request(
      `${detailPath(conversationId)}/archive`,
      {
        body: JSON.stringify({ archived: true, lastSeenAt: detail.lastSeenAt }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(archived.status).toBe(200);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    const [item] = await getDb()
      .select({ status: juniorInboxItems.status })
      .from(juniorInboxItems)
      .where(eq(juniorInboxItems.ownerId, conversationId));
    expect(item?.status).toBe("open");
  });
});
