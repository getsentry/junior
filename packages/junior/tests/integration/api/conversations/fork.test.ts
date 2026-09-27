import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { forkConversationResponseSchema } from "@/api/schema";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { loadProjection } from "@/chat/conversations/projection";
import { readConversationDetail } from "@/api/conversations/detail";
import {
  createConversationWebHarness,
  closeConversationFixture,
} from "../../../fixtures/conversation";
import { createModelStream } from "../../../fixtures/model-stream";
import { testViewer } from "../../../fixtures/user";

function api(email = "alice@example.com") {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(email));
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

function requestFork(
  app: ReturnType<typeof api>,
  conversationId: string,
  messageSeq: number,
  key = "fork",
) {
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/fork`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageSeq, idempotencyKey: key }),
    },
  );
}

describe("conversation fork API", () => {
  afterEach(closeConversationFixture);

  it("copies the same full prefix from a reply or the next user message and continues independently", async () => {
    const harness = await createConversationWebHarness(
      createModelStream([{ type: "text", text: "First answer." }]),
    );
    const source = await harness.start({
      idempotencyKey: "source",
      message: "Remember the first request.",
    });
    await harness.drain();
    const firstProjection = await loadProjection(source);
    const firstHistory = await getConversationEventStore().loadHistory(
      source.conversationId,
    );
    const reply = firstHistory.find(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    )!;
    harness.setModelStream(
      createModelStream([{ type: "text", text: "Second answer." }]),
    );
    await harness.continue({
      conversationId: source.conversationId,
      idempotencyKey: "second",
      message: "Try a different approach.",
    });
    await harness.drain();
    const sourceHistory = await getConversationEventStore().loadHistory(
      source.conversationId,
    );
    const user = sourceHistory.find(
      (event) =>
        event.data.type === "message" &&
        event.data.text === "Try a different approach.",
    )!;
    const app = api();
    const assistantResponse = await requestFork(
      app,
      source.conversationId,
      reply.seq,
    );
    expect(assistantResponse.status).toBe(200);
    const assistantFork = forkConversationResponseSchema.parse(
      await assistantResponse.json(),
    );
    expect(assistantFork.prefill).toBe("");
    const userResponse = await requestFork(
      app,
      source.conversationId,
      user.seq,
    );
    expect(userResponse.status).toBe(200);
    const userFork = forkConversationResponseSchema.parse(
      await userResponse.json(),
    );
    expect(userFork.prefill).toBe("Try a different approach.");
    expect(userFork.conversationId).not.toBe(assistantFork.conversationId);
    const prefix = sourceHistory.filter((event) => event.seq <= reply.seq);
    for (const fork of [assistantFork, userFork]) {
      expect(
        await getConversationEventStore().loadHistory(fork.conversationId),
      ).toEqual(prefix);
      expect(await loadProjection(fork)).toEqual(firstProjection);
      const conversation = await getConversationStore().get(fork);
      expect(conversation).toMatchObject({
        source: "web",
        execution: { status: "idle" },
        visibility: "public",
        destination: { platform: "local", conversationId: fork.conversationId },
      });
      expect(conversation?.parentConversationId).toBeUndefined();
      expect(conversation?.location).toBeUndefined();
      expect(await harness.pendingMessages(fork.conversationId)).toMatchObject({
        messages: [],
      });
      expect(
        await readConversationDetail(fork.conversationId, {
          viewer: testViewer(harness.actor.email),
        }),
      ).toMatchObject({ isParticipant: true });
    }
    expect(harness.queue.hasQueuedMessages()).toBe(false);
    const retry = await requestFork(app, source.conversationId, user.seq);
    expect(await retry.json()).toEqual(userFork);
    const emptyResponse = await requestFork(
      app,
      source.conversationId,
      sourceHistory.find(
        (event) => event.data.type === "message" && event.data.role === "user",
      )!.seq,
    );
    const emptyFork = forkConversationResponseSchema.parse(
      await emptyResponse.json(),
    );
    expect(emptyFork.prefill).toBe("Remember the first request.");
    expect(
      await getConversationEventStore().loadHistory(emptyFork.conversationId),
    ).toEqual([]);

    harness.setModelStream(
      createModelStream([{ type: "text", text: "Independent answer." }]),
    );
    await harness.continue({
      conversationId: userFork.conversationId,
      idempotencyKey: "continue-fork",
      message: "Use the copied context.",
    });
    await harness.drain();
    expect(await harness.historyTexts(userFork.conversationId)).toEqual([
      "Remember the first request.",
      "First answer.",
      "Use the copied context.",
      "Independent answer.",
    ]);
    expect(
      await getConversationEventStore().loadHistory(source.conversationId),
    ).toEqual(sourceHistory);
    expect(
      (await loadProjection(userFork)).slice(0, firstProjection.length),
    ).toEqual(firstProjection);
  });

  it("copies history replacements without replaying older model history or accepting an open tool call", async () => {
    const conversationId = "local:web:compacted-source";
    const store = getConversationEventStore();
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      source: "web",
      visibility: "public",
    });
    await store.append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "user_message",
          provenance: { authority: "context" },
          content: "Old model context",
          timestamp: 1,
        },
      },
    ]);
    await store.replaceHistory(conversationId, {
      createdAtMs: 2,
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "test-model",
        replacementHistory: [
          {
            item: {
              type: "user_message",
              provenance: { authority: "context" },
              content: "Compacted context",
              timestamp: 2,
            },
          },
        ],
      },
    });
    await store.append(conversationId, [
      {
        createdAtMs: 3,
        data: {
          type: "assistant_message",
          content: [{ type: "text", text: "Answer after compaction" }],
          stopReason: "stop",
          timestamp: 3,
        },
      },
      {
        createdAtMs: 4,
        data: {
          type: "message",
          role: "assistant",
          messageId: "reply",
          text: "Answer after compaction",
        },
      },
    ]);
    const history = await store.loadHistory(conversationId);
    const response = await requestFork(
      api(),
      conversationId,
      history.at(-1)!.seq,
    );
    expect(response.status).toBe(200);
    const fork = forkConversationResponseSchema.parse(await response.json());
    expect(await store.loadHistory(fork.conversationId)).toEqual(history);
    expect(await loadProjection(fork)).toEqual(
      await loadProjection({ conversationId }),
    );
    expect(await loadProjection(fork)).toHaveLength(2);
    await store.append(conversationId, [
      {
        createdAtMs: 5,
        data: {
          type: "assistant_message",
          content: [
            { type: "toolCall", id: "open", name: "bash", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 5,
        },
      },
      {
        createdAtMs: 6,
        data: {
          type: "message",
          role: "assistant",
          messageId: "incomplete",
          text: "Incomplete reply",
        },
      },
    ]);
    const incomplete = (await store.loadHistory(conversationId)).at(-1)!;
    expect(
      (await requestFork(api(), conversationId, incomplete.seq)).status,
    ).toBe(409);
  });

  it("keeps private forks private and rejects inaccessible or incomplete history", async () => {
    const conversationId = "local:web:private-source";
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      actor: { email: "alice@example.com" },
      source: "web",
      visibility: "private",
    });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "message",
          role: "user",
          messageId: "user",
          text: "Private question",
        },
      },
      {
        createdAtMs: 2,
        data: {
          type: "message",
          role: "assistant",
          messageId: "fallback",
          text: "Fallback without agent history",
        },
      },
    ]);
    expect(
      (await requestFork(api("other@example.com"), conversationId, 0)).status,
    ).toBe(404);
    expect(
      (await requestFork(createJuniorApi(), conversationId, 0)).status,
    ).toBe(401);
    expect((await requestFork(api(), conversationId, 1)).status).toBe(409);
    expect((await requestFork(api(), conversationId, 999)).status).toBe(409);
    const response = await requestFork(api(), conversationId, 0);
    expect(response.status).toBe(200);
    const fork = forkConversationResponseSchema.parse(await response.json());
    expect(await getConversationStore().get(fork)).toMatchObject({
      visibility: "private",
    });
    expect(
      (
        await readConversationDetail(fork.conversationId, {
          viewer: testViewer("other@example.com"),
        })
      )?.eventHistory.status,
    ).toBe("redacted");
  });
});
