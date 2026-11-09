import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
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
import { getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { closeReviewItem } from "@/chat/review-items/store";
import type { ConversationStore } from "@/chat/conversations/store";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { createAddReviewItemTool } from "@/chat/tools/review-items";
import { juniorReviewItems } from "@/db/schema";
import {
  spawnChildAgent,
  startRunningChildAgent,
} from "../../../fixtures/agent-invocations";
import { neverRunAgentRunner } from "../../../fixtures/agent-runner";
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
      kind: "choice",
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

  it("is active while input waits, failed after its Turn fails, and active again for new input", async () => {
    const fixture = await createStatusFixture(failingAgentRunner);
    const conversationId = await fixture.start("status-failed");
    await expect(fixture.status(conversationId)).resolves.toBe("active");

    await fixture.drain();
    await expect(fixture.status(conversationId)).resolves.toBe("failed");
    // The feed reads the same status as the detail.
    await expect(fixture.feedStatus(conversationId)).resolves.toBe("failed");

    // A failure does not hold input.
    await expect(
      fixture.send(conversationId, "status-failed-retry"),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(fixture.status(conversationId)).resolves.toBe("active");
  });

  it("needs input only while an open action item that it added waits on someone", async () => {
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
    await addItem(conversationId, {
      kind: "action",
      title: "Pick a release name",
      body: "No one is asked.",
      request: REQUEST,
    });
    await expect(fixture.status(conversationId)).resolves.toBe("idle");
    const before = await fixture.request(detailPath(conversationId));
    const version = before.headers.get(CONVERSATION_DETAIL_VERSION_HEADER);
    expect(version).toBeTruthy();

    const everyone = await addItem(conversationId, {
      ...ACTION_ITEM,
      assignees: ["everyone"],
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
      id: everyone,
      nowMs: Date.now(),
      status: "dismissed",
    });
    await expect(fixture.status(conversationId)).resolves.toBe("idle");

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
    await expect(fixture.status(conversationId)).resolves.toBe("active");
  });

  it("orders statuses active, stopped, failed, needs_input", async () => {
    const fixture = await createStatusFixture(failingAgentRunner);
    const conversationId = await fixture.start("status-precedence");
    await addItem(conversationId, ACTION_ITEM);
    await expect(fixture.status(conversationId)).resolves.toBe("active");

    await fixture.drain();
    await expect(fixture.status(conversationId)).resolves.toBe("failed");

    const stopped = await fixture.request(
      `${detailPath(conversationId)}/stop`,
      {
        method: "POST",
      },
    );
    expect(stopped.status).toBe(200);
    await expect(fixture.status(conversationId)).resolves.toBe("stopped");
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

    await expect(fixture.status(conversationId)).resolves.toBe("idle");
    await expect(
      fixture.status(running.invocation.childConversationId),
    ).resolves.toBe("active");
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
