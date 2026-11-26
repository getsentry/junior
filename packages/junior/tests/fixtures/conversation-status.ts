/** Shared setup for the Conversation status and tree state tests. */
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { expect } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
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
import type { ConversationStore } from "@/chat/conversations/store";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { createWatch } from "@/chat/events/store";
import { insertInboxItem } from "@/chat/inbox-items/store";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { neverRunAgentRunner } from "./agent-runner";
import { webTestActor } from "./conversation";
import {
  createConversationWorkHarness,
  createConversationWorkQueueTestAdapter,
} from "./conversation-work";

export const SLACK_VIEWER = {
  email: webTestActor.email,
  slackUserId: "UALICE",
  teamId: "TSTATUS",
};

export const SLACK_DESTINATION = {
  platform: "slack" as const,
  channelId: "CSTATUS",
  teamId: "TSTATUS",
};

export const REQUEST = {
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

export const ACTION_ITEM = {
  kind: "action",
  title: "Ship the release?",
  body: "The release is ready.",
  assignees: [webTestActor.email],
  request: REQUEST,
};

// Injected fault: the agent runner throws on each delivery, so the final
// attempt fails the Turn.
export const failingAgentRunner: AgentRunner = {
  run: async () => {
    throw new Error("model exploded");
  },
};

/** The newest Event seq of the Conversation. */
export async function lastSeq(conversationId: string): Promise<number> {
  const [row] = await getDb()
    .select({ seq: max(juniorConversationEvents.seq) })
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId));
  return row?.seq ?? -1;
}

/** Store a Message by the root's actor that starts no Turn. */
export async function recordStarterMessage(
  conversationId: string,
): Promise<void> {
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

/** The dashboard API path of one Conversation detail. */
export function detailPath(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}`;
}

/** Wire Conversation work and the dashboard API as the web test viewer. */
export async function createStatusFixture(agentRunner = neverRunAgentRunner()) {
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
  const detail = async (conversationId: string) => {
    const response = await request(detailPath(conversationId));
    expect(response.status).toBe(200);
    return conversationDetailReportSchema.parse(await response.json());
  };
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
    detail,
    status: async (conversationId: string) =>
      (await detail(conversationId)).status,
    feedTurnActive: async (conversationId: string) => {
      const response = await request("/api/conversations");
      return conversationFeedSchema
        .parse(await response.json())
        .conversations.find(
          (conversation) => conversation.conversationId === conversationId,
        )?.turnActive;
    },
    tree: async (conversationId: string) => {
      const response = await request(detailPath(conversationId));
      expect(response.status).toBe(200);
      const { treeState, watching } = conversationDetailReportSchema.parse(
        await response.json(),
      );
      return { treeState, watching };
    },
    feedTree: async (conversationId: string) => {
      const response = await request("/api/conversations");
      const row = conversationFeedSchema
        .parse(await response.json())
        .conversations.find(
          (conversation) => conversation.conversationId === conversationId,
        );
      return row && { treeState: row.treeState, watching: row.watching };
    },
    feedRow: async (conversationId: string) => {
      const response = await request("/api/conversations");
      return conversationFeedSchema
        .parse(await response.json())
        .conversations.find(
          (conversation) => conversation.conversationId === conversationId,
        );
    },
  };
}

/** Record an idle public Slack Conversation that the web test viewer is in. */
export async function recordSlackRoot(
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
export async function recordDashboardRoot(
  conversationStore: ConversationStore,
  conversationId: string,
  starter: {
    email: string;
    slackUserId: string;
    teamId: string;
  } = SLACK_VIEWER,
): Promise<string> {
  await conversationStore.recordActivity({
    actor: { platform: "slack", ...starter },
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs: Date.now(),
    source: "local",
    visibility: "public",
  });
  return conversationId;
}

/** Record one assistant reply. */
export async function recordAnswer(
  conversationId: string,
  n: number,
  createdAtMs = Date.now(),
  source?: "slack",
): Promise<void> {
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "message",
        messageId: `${conversationId}:answer-${n}`,
        role: "assistant",
        text: "It shipped.",
        ...(source ? { meta: { source } } : undefined),
      },
      createdAtMs,
    },
  ]);
}

/** Add one Inbox item as the agent of `conversationId` does. */
export async function addItem(
  conversationId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = createAddInboxItemTool(
    {
      conversationId,
      resolveActorIdentity: async () => undefined,
      source: { kind: "scheduled_automation" },
    },
    createSlackInboxItemToolServices(createConversationWorkQueueTestAdapter),
  );
  const result = await (tool as any).execute(
    (tool as any).prepareArguments(input),
    {},
  );
  return result.item.id;
}

/**
 * Store the open `ACTION_ITEM` of `conversationId` for the web test viewer,
 * as an agent added it earlier. Unlike `addItem`, it sends no `waiting`
 * update to a parent agent, so the parent has no queued Turn.
 */
export async function storeActionItem(conversationId: string): Promise<void> {
  const viewer = await resolveViewerUser(webTestActor.email);
  if (!viewer) throw new Error("Expected the web test viewer");
  await insertInboxItem(getDb(), {
    owner: { id: conversationId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: [viewer.id],
    body: ACTION_ITEM.body,
    conversationIds: [conversationId],
    dedupeKey: `action:${conversationId}`,
    kind: "action",
    nowMs: Date.now(),
    request: REQUEST,
    title: ACTION_ITEM.title,
    visibility: "public",
  });
}

/** Start a Watch on a deployment for `conversationId`. */
export async function watchDeployment(conversationId: string) {
  return await createWatch({
    conversationId,
    events: ["deployment.succeeded"],
    expiresAtMs: Date.now() + 3_600_000,
    identifier: "prj_junior:production",
    intent: "Report deploy results.",
    label: "Vercel deployment junior-prod",
    namespace: "vercel",
    resourceType: "deployment",
  });
}

/** The tree state of a tree that waits on nothing. */
export const DONE = { treeState: "done", watching: false };
