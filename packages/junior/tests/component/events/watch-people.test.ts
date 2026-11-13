import { turnBehavior } from "@/chat/conversations/kind-behavior";
import {
  createSlackSource,
  defineJuniorPlugin,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb, getSqlExecutor } from "@/chat/db";
import { ingestEvent } from "@/chat/events/ingest";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

const rootTurnTools = turnBehavior({
  kind: "root",
  personInput: true,
}).tools;

async function seedSlackUser(args: {
  demoLogin?: string;
  email: string;
  slackTeamId?: string;
  slackUserId: string;
}): Promise<void> {
  const slack = await upsertIdentity(getSqlExecutor(), {
    kind: "user",
    provider: "slack",
    providerTenantId: args.slackTeamId ?? "T123",
    providerSubjectId: args.slackUserId,
    email: args.email,
    emailVerified: true,
  });
  if (!args.demoLogin) return;
  await upsertLinkedIdentity(getSqlExecutor(), slack.userId!, {
    kind: "user",
    provider: "demo",
    providerSubjectId: `demo-${args.demoLogin}`,
    handle: args.demoLogin,
  });
}

describe("Watch Event people", () => {
  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
  });

  it("mentions linked Event people and applies Watch guidance per event", async () => {
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
            events: {
              "job.failed": { reach: "resource" },
              "job.succeeded": { reach: "resource" },
            },
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
    await seedSlackUser({
      demoLogin: "Requester",
      email: "requester@example.com",
      slackUserId: "U123",
    });
    await seedSlackUser({
      email: "coauthor@example.com",
      slackUserId: "U456",
    });
    // The same person in another Slack workspace is neither ambiguous nor
    // mentioned.
    await seedSlackUser({
      email: "coauthor@example.com",
      slackTeamId: "T999",
      slackUserId: "U999",
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
    await events!.subscribe({
      events: ["job.failed", "job.succeeded"],
      guidance: { "job.succeeded": "Tell the people involved." },
      intent: "Watch the job.",
      resource: {
        identifier: "job-1",
        label: "Demo job 1",
        namespace: "demo",
        supported_events: ["job.failed", "job.succeeded"],
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
          // The Event names this linked person by handle only. A handle
          // names a person for wording and never makes them trusted.
          author: { handle: "REQUESTER", trusted: true },
          // Handles match without case. Unlinked people and repeats drop out.
          people: [
            { provider: "demo", handle: "requester" },
            { email: "CoAuthor@example.com" },
            { provider: "demo", handle: "unlinked" },
            { email: "requester@example.com" },
          ],
        },
        {
          authorTrust: async () => ({ status: "trusted" }),
          queue,
          slackTeamId: "T123",
        },
      );
    }

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    const [succeeded, failed] = (work?.messages ?? []).map(
      (message) => message.input.text,
    );
    // The doer is in the people involved, so they are listed once, with the
    // handle that the Event uses for them.
    expect(succeeded).toContain(
      '<people><@U123> (did what this Event describes; called "REQUESTER" in the Event data), <@U456></people>\n',
    );
    expect(succeeded).not.toContain("<done-by>");
    expect(succeeded).toContain("Tell the people involved.");
    // Watch guidance applies only to its own event type.
    expect(failed).toContain(
      '<people><@U123> (did what this Event describes; called "REQUESTER" in the Event data), <@U456></people>\n',
    );
    expect(failed).not.toContain("Tell the people involved.");
  });
});
