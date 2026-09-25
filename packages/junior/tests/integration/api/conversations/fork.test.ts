import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
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
import {
  closeConversationFixture,
  createConversationWebHarness,
} from "../../../fixtures/conversation";
import { createModelStream } from "../../../fixtures/model-stream";
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

function forkRequest(messageId: string, idempotencyKey = "fork-1") {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cutoff: { kind: "message", messageId },
      idempotencyKey,
    }),
  };
}

describe("conversation forks", () => {
  afterEach(closeConversationFixture);

  it("forks a delivered reply once, preserves its old history version, and continues independently", async () => {
    const harness = await createConversationWebHarness(
      createModelStream([{ type: "text", text: "First answer." }]),
    );
    const source = await harness.start({
      message: "Remember the blue option.",
      idempotencyKey: "source",
    });
    await harness.drain();
    const events = getConversationEventStore();
    const sourceHistory = await events.loadHistory(source.conversationId);
    const reply = sourceHistory.find(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    );
    if (reply?.data.type !== "message")
      throw new Error("Missing delivered reply");
    const original = await openConversationProjection({
      conversationId: source.conversationId,
    });
    // A newer compaction must not leak later knowledge into an earlier fork.
    await events.replaceHistory(source.conversationId, {
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
    const app = await authenticatedApi(harness.actor.email);
    const url = `/api/conversations/${encodeURIComponent(source.conversationId)}/forks`;
    const responses = await Promise.all([
      app.request(url, forkRequest(reply.data.messageId)),
      app.request(url, forkRequest(reply.data.messageId)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all(
      responses.map(async (response) =>
        forkConversationResponseSchema.parse(await response.json()),
      ),
    );
    expect(new Set(results.map((result) => result.conversationId)).size).toBe(
      1,
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      "created",
      "duplicate",
    ]);
    const forkId = results[0]!.conversationId;
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
      forkedFromConversationId: source.conversationId,
      rootConversationId: forkId,
      parentConversationId: null,
      executionStatus: "idle",
    });
    const detail = conversationDetailReportSchema.parse(
      await (
        await app.request(`/api/conversations/${encodeURIComponent(forkId)}`)
      ).json(),
    );
    expect(detail).toMatchObject({
      isParticipant: true,
      forkedFromConversationId: source.conversationId,
    });
    expect(detail.modelUsage).toBeUndefined();
    expect((await harness.pendingMessages(forkId)).messages).toEqual([]);
    const sourceDetail = conversationDetailReportSchema.parse(
      await (
        await app.request(
          `/api/conversations/${encodeURIComponent(source.conversationId)}`,
        )
      ).json(),
    );
    expect(sourceDetail.forks).toEqual([forkId]);
    harness.setModelStream(
      createModelStream([{ type: "text", text: "Independent answer." }]),
    );
    await harness.continue({
      conversationId: forkId,
      message: "Try the green option instead.",
      idempotencyKey: "next",
    });
    await harness.drain();
    expect(await harness.historyTexts(forkId)).toContain("Independent answer.");
    expect(await harness.historyTexts(source.conversationId)).not.toContain(
      "Independent answer.",
    );
    expect(harness.agentRuns.at(-1)?.conversationId).toBe(forkId);
    expect(harness.agentRuns.at(-1)?.state?.sandboxRef).toBeUndefined();
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
    const message = fauxAssistantMessage("Private answer.");
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
    const owner = await authenticatedApi("owner@example.com");
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
    const toolCall = fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "pending",
          name: "bash",
          arguments: { command: "echo hello" },
        },
      ],
      { stopReason: "toolUse" },
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
