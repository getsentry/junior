import { turnBehavior } from "@/chat/conversations/kind-behavior";
import {
  createSlackSource,
  defineJuniorPlugin,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { botConfig } from "@/chat/config";
import { loadTurnConversationNotes } from "@/chat/conversations/notes";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { closeDb } from "@/chat/db";
import { ingestEvent } from "@/chat/events/ingest";
import { createWatch, listWatches } from "@/chat/events/store";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { countAutomatedTurn } from "@/chat/services/automated-turn-limit";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createListWatchesTool } from "@/chat/tools/list-watches";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

const rootTurnTools = turnBehavior({
  kind: "root",
  personInput: true,
}).tools;

const resource = {
  identifier: "job-1",
  label: "Demo job 1",
  namespace: "demo",
  supported_events: ["job.failed", "job.succeeded"],
  type: "job",
};

async function pluginEvents(
  queue: ReturnType<typeof createConversationWorkQueueTestAdapter>,
) {
  let events: ToolRegistrationHookContext["events"] | undefined;
  await createApp({
    conversationWork: { queue, run: async () => ({ status: "completed" }) },
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: { name: "demo", displayName: "Demo", description: "Demo" },
        events: {
          resourceTypes: [
            { type: "job", supportedEvents: ["job.failed", "job.succeeded"] },
          ],
          events: {
            "job.failed": { reach: "resource" },
            "job.succeeded": { reach: "resource" },
          },
        },
        hooks: {
          tools() {
            return {};
          },
          disabledTools(ctx) {
            events = ctx.events;
            return {};
          },
        },
      }),
    ]),
  });
  getPluginTools({
    turnTools: rootTurnTools,
    conversationId: CONVERSATION_ID,
    destination: SLACK_DESTINATION,
    egress: { fetch: async () => new Response("ok") },
    source: createSlackSource({
      teamId: "T123",
      channelId: "C123",
      visibility: "public",
    }),
    workspace: {} as any,
  });
  return events!;
}

describe("Quiet Events", () => {
  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
  });

  it("saves a Quiet Event as a Conversation note that starts no Turn", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const events = await pluginEvents(queue);
    // The result lists only the events that start a Turn.
    await expect(
      events.subscribe({
        events: ["job.failed", "job.succeeded"],
        intent: "Fix the job when it fails.",
        quietEvents: ["job.succeeded"],
        resource,
      }),
    ).resolves.toMatchObject({ events: ["job.failed"] });
    const listed = createListWatchesTool({
      conversationId: CONVERSATION_ID,
    } as ToolRuntimeContext);
    await expect(listed.execute!({}, {} as never)).resolves.toMatchObject({
      subscriptions: [
        { events: ["job.failed"], quiet_events: ["job.succeeded"] },
      ],
    });
    // The automated-turn limit counts Turns, so it does not hold back a
    // Quiet Event.
    const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
    for (let i = 0; i < maxTurns; i += 1) {
      await countAutomatedTurn({
        conversationId: CONVERSATION_ID,
        maxTurns,
        nowMs: Date.now() + i,
      });
    }

    await expect(
      ingestEvent(
        {
          eventKey: "delivery-succeeded",
          eventType: "job.succeeded",
          occurredAtMs: Date.now(),
          namespace: "demo",
          identifier: "job-1",
          terminal: true,
          trustedSummary: "Demo job 1 succeeded.",
        },
        { queue },
      ),
    ).resolves.toEqual({ enqueued: 0 });

    expect(queue.sentRecords()).toEqual([]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work?.messages ?? []).toHaveLength(0);
    // A terminal Quiet Event still completes the Watch.
    await expect(
      listWatches({ conversationId: CONVERSATION_ID }),
    ).resolves.toEqual([]);
    // The next Turn gets the note once, with how to use it.
    await getTurnLifecycle().start({
      conversationId: CONVERSATION_ID,
      createdAtMs: Date.now(),
      inputMessageIds: ["turn-after-success-message"],
      surface: "internal",
      turnId: "turn-after-success",
    });
    await expect(
      loadTurnConversationNotes({
        conversationId: CONVERSATION_ID,
        turnId: "turn-after-success",
      }),
    ).resolves.toEqual([
      "A Watch received this Event quietly: it started no Turn, and nobody was told. Use it as current state. Do not tell people about it unless they ask or your work needs it. Demo job 1, job.succeeded: Demo job 1 succeeded.",
    ]);
  });

  it("adds no note when another Watch starts a Turn for the Event", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const events = await pluginEvents(queue);
    await events.subscribe({
      events: ["job.failed", "job.succeeded"],
      intent: "Fix the job when it fails.",
      quietEvents: ["job.succeeded"],
      resource,
    });
    // A person asked to hear when the job succeeds.
    await createWatch({
      conversationId: CONVERSATION_ID,
      events: ["job.succeeded"],
      expiresAtMs: Date.now() + 60_000,
      intent: "Tell the person when the job succeeds.",
      label: resource.label,
      namespace: resource.namespace,
      identifier: resource.identifier,
      resourceType: resource.type,
    });

    await expect(
      ingestEvent(
        {
          eventKey: "delivery-succeeded",
          eventType: "job.succeeded",
          occurredAtMs: Date.now(),
          namespace: "demo",
          identifier: "job-1",
          terminal: true,
          trustedSummary: "Demo job 1 succeeded.",
        },
        { queue },
      ),
    ).resolves.toEqual({ enqueued: 1 });

    await getTurnLifecycle().start({
      conversationId: CONVERSATION_ID,
      createdAtMs: Date.now(),
      inputMessageIds: ["turn-for-success-message"],
      surface: "internal",
      turnId: "turn-for-success",
    });
    await expect(
      loadTurnConversationNotes({
        conversationId: CONVERSATION_ID,
        turnId: "turn-for-success",
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a Watch whose every event is quiet", async () => {
    const events = await pluginEvents(createConversationWorkQueueTestAdapter());

    await expect(
      events.subscribe({
        events: ["job.succeeded"],
        intent: "Know when the job succeeds.",
        quietEvents: ["job.succeeded"],
        resource,
      }),
    ).rejects.toThrow("Watch requires at least one event that starts a Turn");
  });
});
