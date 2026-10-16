import {
  createSlackSource,
  defineJuniorPlugin,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb } from "@/chat/db";
import { ingestEvent } from "@/chat/events/ingest";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

const REQUESTER = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const;

describe("tool Watch people", () => {
  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
  });

  it("lists the run's people and Watch guidance on each matching event", async () => {
    const queue = createConversationWorkQueueTestAdapter();
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
          },
          hooks: {
            tools(ctx) {
              events = ctx.events;
              return {};
            },
          },
        }),
      ]),
    });
    getPluginTools({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      actor: REQUESTER,
      // The current Actor repeats, and system Actors are not people.
      actors: () => [
        REQUESTER,
        { platform: "slack", teamId: "T123", userId: "U456" },
        { platform: "system", name: "junior-event" },
      ],
      egress: { fetch: async () => new Response("ok") },
      source: createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "public",
      }),
      workspace: {} as any,
    });
    await events!.subscribe({
      events: ["job.failed", "job.succeeded"],
      guidance: { "job.succeeded": "Tell the people involved." },
      includeActors: true,
      intent: "Watch the job.",
      resource: {
        identifier: "job-1",
        label: "Demo job 1",
        namespace: "demo",
        supportedEvents: ["job.failed", "job.succeeded"],
        type: "job",
      },
    });

    for (const eventType of ["job.succeeded", "job.failed"]) {
      await ingestEvent(
        {
          eventKey: `delivery-${eventType}`,
          eventType,
          occurredAtMs: Date.now(),
          namespace: "demo",
          identifier: "job-1",
          trustedSummary: `Demo job 1: ${eventType}.`,
        },
        { queue },
      );
    }

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    const [succeeded, failed] = (work?.messages ?? []).map(
      (message) => message.input.text,
    );
    expect(succeeded).toContain("People involved: <@U123>, <@U456>");
    expect(succeeded).toContain("Tell the people involved.");
    // Watch guidance applies only to its own event type.
    expect(failed).toContain("People involved: <@U123>, <@U456>");
    expect(failed).not.toContain("Tell the people involved.");
  });
});
