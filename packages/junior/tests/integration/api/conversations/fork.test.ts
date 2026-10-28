import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  forkConversationResponseSchema,
  conversationDetailReportSchema,
} from "@/api/schema";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { openConversationProjection } from "@/chat/conversations/projection";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import { contextProvenance } from "@/chat/conversations/provenance";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { closeConversationFixture } from "../../../fixtures/conversation";
import { juniorConversations } from "@/db/schema";
import { eq } from "drizzle-orm";

async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error("Missing test viewer");
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

const OWNER_EMAIL = "owner@example.com";

/** A stored assistant message, as a completed model call leaves it. */
function assistantMessage(
  content: AssistantMessage["content"] | string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content:
      typeof content === "string" ? [{ type: "text", text: content }] : content,
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: "test-model",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/** Store one answered web turn and return its delivered reply id. */
async function storeAnsweredTurn(
  conversationId: string,
  args: { answer: string; question: string; turn: string },
): Promise<string> {
  const store = getConversationStore();
  if (!(await store.get({ conversationId }))) {
    await store.recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      actor: { email: OWNER_EMAIL },
      source: "web",
      visibility: "private",
    });
  }
  const events = getConversationEventStore();
  const lifecycle = getTurnLifecycle();
  const turnId = `turn_${args.turn}`;
  const replyId = `${turnId}:assistant:1`;
  await events.append(conversationId, [
    {
      createdAtMs: Date.now(),
      data: {
        type: "message",
        messageId: `${args.turn}-question`,
        role: "user",
        text: args.question,
      },
    },
  ]);
  await lifecycle.start({
    conversationId,
    createdAtMs: Date.now(),
    inputMessageIds: [`${args.turn}-question`],
    surface: "api",
    turnId,
  });
  await events.append(conversationId, [
    {
      createdAtMs: Date.now(),
      idempotencyKey: `message:${replyId}:agent`,
      data: historyItemFromPiMessage(
        assistantMessage(args.answer),
        contextProvenance,
      ),
    },
    {
      createdAtMs: Date.now(),
      data: {
        type: "message",
        messageId: replyId,
        role: "assistant",
        text: args.answer,
      },
    },
  ]);
  await lifecycle.complete({
    conversationId,
    createdAtMs: Date.now(),
    outcome: "success",
    turnId,
  });
  return replyId;
}

function forkRequest(messageId: string, idempotencyKey = "fork-1") {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId, idempotencyKey }),
  };
}

/** Messages and Turns, as the transcript and event log show them. */
function visibleEvents(detail: { events: Array<{ data: unknown }> }) {
  return detail.events.flatMap(({ data }) => {
    const event = data as { type: string; role?: string; text?: string };
    if (event.type === "message") return [`${event.role}: ${event.text}`];
    if (event.type === "turn_lifecycle") return ["turn"];
    return [];
  });
}

describe("conversation forks", () => {
  afterEach(closeConversationFixture);

  it("forks a delivered reply once and preserves its old history version", async () => {
    const source = "local:web:fork-source";
    const reply = await storeAnsweredTurn(source, {
      question: "Remember the blue option.",
      answer: "First answer.",
      turn: "source",
    });
    const events = getConversationEventStore();
    const original = await openConversationProjection({
      conversationId: source,
    });
    // A newer compaction must not leak later knowledge into an earlier fork.
    await events.replaceHistory(source, {
      createdAtMs: Date.now(),
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "test-model",
        replacementHistory: [
          {
            item: {
              type: "user_message",
              provenance: contextProvenance,
              content: [
                {
                  type: "text",
                  text: "Later knowledge, not part of the fork.",
                },
              ],
              timestamp: Date.now(),
            },
          },
        ],
      },
    });
    await getDb()
      .update(juniorConversations)
      .set({ title: "Blue option plan" })
      .where(eq(juniorConversations.conversationId, source));
    const app = await authenticatedApi(OWNER_EMAIL);
    const url = `/api/conversations/${encodeURIComponent(source)}/forks`;
    const responses = await Promise.all([
      app.request(url, forkRequest(reply)),
      app.request(url, forkRequest(reply)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all(
      responses.map(async (response) =>
        forkConversationResponseSchema.parse(await response.json()),
      ),
    );
    const forkId = results[0]!.conversationId;
    expect(results[1]!.conversationId).toBe(forkId);
    const projection = await openConversationProjection({
      conversationId: forkId,
    });
    expect(projection.messages.slice(0, original.messages.length)).toEqual(
      original.messages,
    );
    expect(projection.messages).toHaveLength(original.messages.length + 1);
    const [row] = await getDb()
      .select()
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, forkId));
    expect(row).toMatchObject({
      forkedFromConversationId: source,
      rootConversationId: forkId,
      parentConversationId: null,
      executionStatus: "idle",
    });
    const readDetail = async (id: string) =>
      conversationDetailReportSchema.parse(
        await (
          await app.request(`/api/conversations/${encodeURIComponent(id)}`)
        ).json(),
      );
    const detail = await readDetail(forkId);
    expect(detail).toMatchObject({
      isParticipant: true,
      forkedFromConversationId: source,
      forkedFromTitle: "Blue option plan",
    });
    expect(detail.modelUsage).toBeUndefined();
    const sourceDetail = await readDetail(source);
    expect(sourceDetail.forks).toEqual([forkId]);
    // The fork shows a copy of the source transcript and event log.
    expect(visibleEvents(detail)).toEqual(visibleEvents(sourceDetail));
    expect(visibleEvents(detail)).toEqual([
      "user: Remember the blue option.",
      "turn",
      "assistant: First answer.",
      "turn",
    ]);

    // A fork of the fork writes its own note after all copied model calls.
    const forkReply = await storeAnsweredTurn(forkId, {
      question: "Try the green option instead.",
      answer: "Independent answer.",
      turn: "fork",
    });
    const nested = forkConversationResponseSchema.parse(
      await (
        await app.request(
          `/api/conversations/${encodeURIComponent(forkId)}/forks`,
          forkRequest(forkReply, "fork-2"),
        )
      ).json(),
    );
    const nestedHistory = await events.loadHistory(nested.conversationId);
    expect(nestedHistory.at(-1)?.idempotencyKey).toBe("fork:note");
    expect(
      nestedHistory.filter((event) => event.idempotencyKey === "fork:note"),
    ).toHaveLength(1);
    expect(
      (await readDetail(nested.conversationId)).modelUsage,
    ).toBeUndefined();
  });

  it("keeps private forks private and rejects inaccessible or unfinished cutoffs without creating roots", async () => {
    const store = getConversationStore();
    const events = getConversationEventStore();
    const source = "local:web:private-source";
    await store.recordActivity({
      conversationId: source,
      destination: { platform: "local", conversationId: source },
      actor: { email: "owner@example.com" },
      source: "web",
      visibility: "private",
    });
    const message = assistantMessage("Private answer.");
    await events.append(source, [
      {
        createdAtMs: Date.now(),
        idempotencyKey: "message:reply:agent",
        data: historyItemFromPiMessage(message, contextProvenance),
      },
      {
        createdAtMs: Date.now(),
        data: {
          type: "message",
          messageId: "reply",
          role: "assistant",
          text: "Private answer.",
        },
      },
    ]);
    const owner = await authenticatedApi(OWNER_EMAIL);
    const stranger = await authenticatedApi("stranger@example.com");
    const url = `/api/conversations/${source}/forks`;
    expect((await stranger.request(url, forkRequest("reply"))).status).toBe(
      403,
    );
    expect((await owner.request(url, forkRequest("missing"))).status).toBe(409);
    expect(
      (await createJuniorApi().request(url, forkRequest("reply"))).status,
    ).toBe(401);
    expect(
      await getDb()
        .select()
        .from(juniorConversations)
        .where(eq(juniorConversations.forkedFromConversationId, source)),
    ).toEqual([]);
    const result = forkConversationResponseSchema.parse(
      await (await owner.request(url, forkRequest("reply"))).json(),
    );
    expect(
      await store.get({ conversationId: result.conversationId }),
    ).toMatchObject({ visibility: "private" });
    const hidden = conversationDetailReportSchema.parse(
      await (
        await stranger.request(`/api/conversations/${result.conversationId}`)
      ).json(),
    );
    expect(hidden.eventHistory.status).toBe("redacted");
    expect(hidden.forkedFromConversationId).toBeUndefined();
    expect(hidden.canFork).toBe(false);
    const child = "local:web:private-child";
    await store.createChild({
      childConversationId: child,
      parentConversationId: source,
    });
    const readDetail = async (id: string) =>
      conversationDetailReportSchema.parse(
        await (await owner.request(`/api/conversations/${id}`)).json(),
      );
    expect((await readDetail(source)).canFork).toBe(true);
    expect((await readDetail(child)).canFork).toBe(false);
    const toolCall = assistantMessage(
      [
        {
          type: "toolCall",
          id: "pending",
          name: "bash",
          arguments: { command: "echo hello" },
        },
      ],
      "toolUse",
    );
    await events.append(source, [
      {
        createdAtMs: Date.now(),
        data: historyItemFromPiMessage(toolCall, contextProvenance),
      },
      {
        createdAtMs: Date.now(),
        idempotencyKey: "message:unfinished:agent",
        data: historyItemFromPiMessage(message, contextProvenance),
      },
    ]);
    expect(
      (await owner.request(url, forkRequest("unfinished", "bad-boundary")))
        .status,
    ).toBe(409);
  });
});
