import { turnBehavior } from "@/chat/conversations/kind-behavior";
import {
  createSlackSource,
  defineJuniorPlugin,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb } from "@/chat/db";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

const rootTurnTools = turnBehavior({
  kind: "root",
  hasParent: false,
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

  // tests/integration/quiet-watch-events.test.ts covers delivery.
  it("lists only the events that start a Turn in the subscribe result", async () => {
    const events = await pluginEvents(createConversationWorkQueueTestAdapter());

    await expect(
      events.subscribe({
        events: ["job.failed", "job.succeeded"],
        intent: "Fix the job when it fails.",
        quietEvents: ["job.succeeded"],
        resource,
      }),
    ).resolves.toMatchObject({ events: ["job.failed"] });
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
