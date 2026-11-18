import { eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  conversationDetailReportSchema,
  conversationFeedSchema,
} from "@/api/schema";
import {
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { closeReviewItem, insertReviewItem } from "@/chat/review-items/store";
import type { ConversationStore } from "@/chat/conversations/store";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { recordAuthorizationRequested } from "@/chat/conversations/projection";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { createAddReviewItemTool } from "@/chat/tools/review-items";
import {
  juniorConversationBriefs,
  juniorConversationEvents,
  juniorConversations,
  juniorReviewItems,
} from "@/db/schema";
import {
  spawnChildAgent,
  startRunningChildAgent,
} from "../../../fixtures/agent-invocations";
import { neverRunAgentRunner } from "../../../fixtures/agent-runner";
import { conversationBriefFixture } from "../../../fixtures/conversation-brief";
import type { BriefOutcomeStatus } from "@/chat/briefs/schema";
import {
  closeConversationFixture,
  webTestActor,
} from "../../../fixtures/conversation";
import {
  createConversationWorkHarness,
  createConversationWorkQueueTestAdapter,
} from "../../../fixtures/conversation-work";

const SLACK_VIEWER = {
  email: webTestActor.email,
  slackUserId: "UALICE",
  teamId: "TSTATUS",
};

const SLACK_DESTINATION = {
  platform: "slack" as const,
  channelId: "CSTATUS",
  teamId: "TSTATUS",
};

const REQUEST = {
  question: "Ship the release now?",
  fields: [
    {
      id: "decision",
      kind: "choice" as const,
      label: "Decision",
      options: [{ label: "Ship" }, { label: "Wait" }],
    },
  ],
};

const ACTION_ITEM = {
  kind: "action",
  title: "Ship the release?",
  body: "The release is ready.",
  assignees: [webTestActor.email],
  request: REQUEST,
};

// Injected fault: the agent runner throws on each delivery, so the final
// attempt fails the Turn.
const failingAgentRunner: AgentRunner = {
  run: async () => {
    throw new Error("model exploded");
  },
};

/** The newest Event seq of the Conversation. */
async function lastSeq(conversationId: string): Promise<number> {
  const [row] = await getDb()
    .select({ seq: max(juniorConversationEvents.seq) })
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId));
  return row?.seq ?? -1;
}

/** Store a Brief that covers every Event so far. */
async function recordBrief(
  conversationId: string,
  version: number,
  status: BriefOutcomeStatus,
): Promise<void> {
  await getDb()
    .insert(juniorConversationBriefs)
    .values({
      conversationId,
      version,
      turnId: `brief-turn-${version}`,
      throughSeq: await lastSeq(conversationId),
      content: conversationBriefFixture({ status }),
      searchText: "stored brief",
      modelId: "test-model",
    });
}

/** Store a Message by the root's actor that starts no Turn. */
async function recordStarterMessage(conversationId: string): Promise<void> {
  const [root] = await getDb()
    .select({ actorIdentityId: juniorConversations.actorIdentityId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  const seq = (await lastSeq(conversationId)) + 1;
  await getDb()
    .insert(juniorConversationEvents)
    .values({
      actorIdentityId: root!.actorIdentityId,
      conversationId,
      createdAt: new Date(),
      historyVersion: 1,
      payload: {
        type: "message",
        messageId: `${conversationId}:later`,
        role: "user",
        text: "Thanks.",
      },
      seq,
      type: "message",
    });
}

function detailPath(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}`;
}

/** Wire Conversation work and the dashboard API as the web test viewer. */
async function createStatusFixture(agentRunner = neverRunAgentRunner()) {
  const work = await createConversationWorkHarness(agentRunner);
  const viewer = await resolveViewerUser(webTestActor.email);
  if (!viewer) throw new Error("Expected the web test viewer");
  const actor = { ...webTestActor, userId: viewer.id };
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: work.queue }));
  const conversationStore = getConversationStore();
  const services = { conversationStore, queue: work.queue, state: work.state };
  const request = async (path: string, init?: RequestInit) =>
    await app.request(`http://localhost${path}`, init);
  return {
    ...work,
    conversationStore,
    /** Run queued work, with redeliveries, until the queue is empty. */
    drain: async () => {
      for (let i = 0; i < 12 && work.queue.hasQueuedMessages(); i += 1) {
        await work.process(work.queue.takeMessage());
      }
    },
    request,
    start: async (idempotencyKey: string) =>
      (
        await createAndEnqueueConversation(
          { actor, idempotencyKey, message: "Check the release." },
          services,
        )
      ).conversationId,
    send: async (conversationId: string, idempotencyKey: string) =>
      await appendAndEnqueueWebMessage(
        { actor, conversationId, idempotencyKey, message: "Try again." },
        services,
      ),
    status: async (conversationId: string) => {
      const response = await request(detailPath(conversationId));
      expect(response.status).toBe(200);
      return conversationDetailReportSchema.parse(await response.json()).status;
    },
    feedStatus: async (conversationId: string) => {
      const response = await request("/api/conversations");
      return conversationFeedSchema
        .parse(await response.json())
        .conversations.find(
          (conversation) => conversation.conversationId === conversationId,
        )?.status;
    },
  };
}

/** Record an idle public Slack Conversation that the web test viewer is in. */
async function recordSlackRoot(
  conversationStore: ConversationStore,
  threadTs: string,
): Promise<string> {
  const conversationId = `slack:CSTATUS:${threadTs}`;
  await conversationStore.recordActivity({
    actor: { platform: "slack", ...SLACK_VIEWER },
    conversationId,
    destination: SLACK_DESTINATION,
    nowMs: Date.now(),
    sessionSource: createSlackSource({
      channelId: SLACK_DESTINATION.channelId,
      teamId: SLACK_DESTINATION.teamId,
      threadTs,
      visibility: "public",
    }),
    source: "slack",
    visibility: "public",
  });
  return conversationId;
}

/** Record a dashboard root, which has no Location, started by the viewer. */
async function recordDashboardRoot(
  conversationStore: ConversationStore,
  conversationId: string,
): Promise<string> {
  await conversationStore.recordActivity({
    actor: { platform: "slack", ...SLACK_VIEWER },
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs: Date.now(),
    source: "local",
    visibility: "private",
  });
  return conversationId;
}

/** Record one assistant reply. */
async function recordAnswer(
  conversationId: string,
  n: number,
  createdAtMs = Date.now(),
): Promise<void> {
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "message",
        messageId: `${conversationId}:answer-${n}`,
        role: "assistant",
        text: "It shipped.",
      },
      createdAtMs,
    },
  ]);
}

/** Add one Review item as the agent of `conversationId` does. */
async function addItem(
  conversationId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = createAddReviewItemTool(
    {
      conversationId,
      resolveActorIdentity: async () => undefined,
      source: { kind: "scheduled_automation" },
    },
    createSlackReviewItemToolServices(createConversationWorkQueueTestAdapter),
  );
  const result = await (tool as any).execute(
    (tool as any).prepareArguments(input),
    {},
  );
  return result.item.id;
}

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
    // The feed reads the same status as the detail.
    await expect(fixture.feedStatus(conversationId)).resolves.toBe(
      "needs_input",
    );

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

    // addReviewItem assigns a Participant by default. A Slack Actor without
    // a User adds an item that no one is assigned to, and anyone in the
    // thread can answer it.
    const unassigned = await insertReviewItem(getDb(), {
      addedByConversationId: conversationId,
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
    await closeReviewItem(getDb(), {
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
    await closeReviewItem(getDb(), {
      id: everyone,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("done");

    const assigned = await addItem(conversationId, ACTION_ITEM);
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    // The person's answer is input for a new Turn.
    const answered = await fixture.request(
      `/api/review-items/${assigned}/actions`,
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
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await closeReviewItem(getDb(), {
      id: item,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("working");

    await fixture.drain();
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");

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
    const read = await fixture.request(
      `${detailPath(conversationId)}/read-position`,
      {
        body: JSON.stringify({ lastReadSeq: await lastSeq(conversationId) }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(read.status).toBe(200);
    await expect(fixture.status(conversationId)).resolves.toBe("done");

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

  it("counts an answer delivered to Slack as read", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordSlackRoot(
      fixture.conversationStore,
      "1700000000.000250",
    );
    await recordAnswer(conversationId, 1);
    await expect(fixture.status(conversationId)).resolves.toBe("done");
  });

  it("reads the Brief outcome", async () => {
    const fixture = await createStatusFixture();
    const conversationId = await recordDashboardRoot(
      fixture.conversationStore,
      "local:web:status-brief",
    );
    await recordAnswer(conversationId, 1);
    // A `done` Brief that covers the answer needs no read.
    await recordBrief(conversationId, 1, "done");
    await expect(fixture.status(conversationId)).resolves.toBe("done");
    await recordBrief(conversationId, 2, "answered");
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await recordBrief(conversationId, 3, "abandoned");
    await expect(fixture.status(conversationId)).resolves.toBe("done");
    // `partial` and `blocked` wait on the starter even after a read.
    await recordStarterMessage(conversationId);
    await recordBrief(conversationId, 4, "partial");
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    await recordBrief(conversationId, 5, "blocked");
    await expect(fixture.status(conversationId)).resolves.toBe("needs_input");
    // A queued Turn works on it, so it waits on no one.
    await expect(
      fixture.send(conversationId, "status-brief-retry"),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(fixture.status(conversationId)).resolves.toBe("working");
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
      fixture.status(running.invocation.childConversationId),
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
      .select({ status: juniorReviewItems.status })
      .from(juniorReviewItems)
      .where(eq(juniorReviewItems.addedByConversationId, conversationId));
    expect(item?.status).toBe("open");
  });
});
