import { randomUUID } from "node:crypto";
import {
  createLocalSource,
  defineConversationEvent,
  defineJuniorPlugin,
  type PluginConversationEventDefinition,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { juniorConversations } from "@/db/schema";

const ORIGINAL_ENV = { ...process.env };

function completedMessages(): PiMessage[] {
  return [
    {
      role: "user",
      content: "Run the registered plugin event task.",
      timestamp: 1,
    },
    {
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      timestamp: 2,
    },
  ];
}

async function recordCompletedSession(args: {
  conversationId: string;
  sessionId: string;
}): Promise<void> {
  const { upsertAgentTurnSessionRecord } =
    await import("@/chat/state/turn-session");
  await upsertAgentTurnSessionRecord({
    actor: {
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    },
    conversationId: args.conversationId,
    destination: {
      platform: "local",
      conversationId: args.conversationId,
    },
    modelId: "test/model",
    piMessages: completedMessages(),
    sessionId: args.sessionId,
    sliceId: 1,
    source: createLocalSource(args.conversationId),
    state: "completed",
    surface: "internal",
  });
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    JUNIOR_STATE_ADAPTER: "memory",
  };
  vi.resetModules();
});

afterEach(async () => {
  const { setPlugins } = await import("@/chat/plugins/agent-hooks");
  const { disconnectStateAdapter } = await import("@/chat/state/adapter");
  setPlugins([]);
  await disconnectStateAdapter();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe("plugin conversation events", () => {
  it("deduplicates task events across schema versions without refreshing activity", async () => {
    const runId = randomUUID();
    const conversationId = `local:test:structured-events-${runId}`;
    const sessionId = `structured-event-session:${runId}`;
    const completedEventV1 = defineConversationEvent({
      name: "session_processed",
      version: 1,
      schema: z.object({ summary: z.string() }).strict(),
      renderEvent(event) {
        return { title: "Session processed", preview: event.summary };
      },
    });
    const completedEventV2 = defineConversationEvent({
      name: "session_processed",
      version: 2,
      schema: z.object({ costUsd: z.number(), summary: z.string() }).strict(),
      renderEvent(event) {
        return { title: "Session processed", preview: event.summary };
      },
    });
    let emittedVersion: 1 | 2 = 1;
    const plugin = (conversationEvents: PluginConversationEventDefinition[]) =>
      defineJuniorPlugin({
        manifest: {
          name: "task-event-demo",
          displayName: "Task Event Demo",
          description: "Task event demo",
        },
        conversationEvents,
        tasks: {
          processSession: {
            async run(ctx) {
              await ctx.events.emit(
                emittedVersion === 1
                  ? completedEventV1({
                      summary: "Background task finished.",
                    })
                  : completedEventV2({
                      costUsd: 0.0042,
                      summary: "Background task finished.",
                    }),
              );
            },
          },
        },
      });
    const { setPlugins } = await import("@/chat/plugins/agent-hooks");
    const { getConversationEventStore, getDb } = await import("@/chat/db");
    const { processPluginTask } = await import("@/chat/plugins/task-runner");
    setPlugins([plugin([completedEventV1])]);
    await recordCompletedSession({ conversationId, sessionId });
    const db = getDb();
    await db
      .update(juniorConversations)
      .set({
        archivedAt: new Date(3_000),
        lastActivityAt: new Date(2_000),
        transcriptPurgedAt: new Date(2_500),
        updatedAt: new Date(2_000),
      })
      .where(eq(juniorConversations.conversationId, conversationId));
    const readConversationState = async () => {
      const [row] = await db
        .select({
          archivedAt: juniorConversations.archivedAt,
          lastActivityAt: juniorConversations.lastActivityAt,
          transcriptPurgedAt: juniorConversations.transcriptPurgedAt,
          updatedAt: juniorConversations.updatedAt,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, conversationId));
      return row;
    };
    const conversationState = await readConversationState();
    const message = {
      name: "processSession",
      params: { conversationId, sessionId },
      plugin: "task-event-demo",
    };

    await processPluginTask(message);
    emittedVersion = 2;
    setPlugins([plugin([completedEventV1, completedEventV2])]);
    await processPluginTask(message);

    expect(await readConversationState()).toEqual(conversationState);
    const events =
      await getConversationEventStore().loadHistory(conversationId);
    expect(
      events.filter((event) => event.data.type === "structured_event"),
    ).toEqual([
      expect.objectContaining({
        data: {
          type: "structured_event",
          namespace: "task-event-demo",
          name: "session_processed",
          version: 1,
          turnId: sessionId,
          content: { summary: "Background task finished." },
        },
      }),
    ]);
  });
});
