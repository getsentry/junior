import { githubPlugin } from "@sentry/junior-github";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { getConversationStore } from "@/chat/db";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import { juniorAutomations } from "@/db/schema/automations";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import { context, execute, teamId } from "../fixtures/event-automations";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_SECRET = "event-automation-test-secret";
});

let fixture: LocalJuniorSqlFixture;
let queue: ConversationWorkQueueTestAdapter;

describe("event automations with no identifier", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    queue = createConversationWorkQueueTestAdapter();
    // The automation tools save cards to the creation Conversation.
    await getConversationStore().recordActivity({
      conversationId: "test:event-annotations",
      destination: {
        platform: "local",
        conversationId: "test:event-annotations",
      },
      source: "local",
      nowMs: Date.now(),
    });
  });

  afterEach(async () => {
    await fixture.sql
      .db()
      .delete(juniorAutomations)
      .where(eq(juniorAutomations.teamId, teamId));
    await fixture.close();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("runs a trigger with no identifier once for each event, within its filters", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    await createApp({
      plugins: defineJuniorPlugins([
        githubPlugin({
          pullRequestEvents: {
            guidance: { "pull_request.opened": "Check the description." },
          },
        }),
      ]),
    });
    try {
      const catalog = getEventCatalog();
      const create = (trigger: Record<string, unknown>, toolCallId: string) =>
        execute(
          createEventAutomationTool(context(), catalog),
          { instruction: "Review the new pull request.", trigger },
          toolCallId,
        ) as Promise<{
          automation: {
            id: string;
            trigger: { identifier: unknown; resourceType: unknown };
          };
        }>;
      const trigger = {
        namespace: "github",
        label: "New pull requests in getsentry/junior",
        events: ["pull_request.opened"],
      };

      // Pull request text can come from a private repository, so the
      // trigger must name one.
      await expect(create(trigger, "no-repo")).rejects.toThrow(
        'This GitHub trigger cannot be saved. This trigger needs a "repo" filter (match.repo), because "pull_request.opened" cannot run for every resource.',
      );
      await expect(
        create(
          { ...trigger, identifier: "getsentry/junior#1", match: {} },
          "half-resource",
        ),
      ).rejects.toThrow("Set both resourceType and identifier");
      const created = await create(
        { ...trigger, match: { repo: "getsentry/junior" } },
        "any-pull-request",
      );
      expect(created.automation.trigger).toMatchObject({
        identifier: null,
        resourceType: null,
      });
      const [row] = await fixture.sql
        .db()
        .select({ identifier: juniorAutomations.identifier })
        .from(juniorAutomations)
        .where(eq(juniorAutomations.id, created.automation.id));
      expect(row).toEqual({ identifier: null });
      // Deployment facts can run for every repository with no filter.
      await create(
        {
          namespace: "github",
          label: "Failed deployments",
          events: ["deployment.failed"],
        },
        "any-deployment",
      );

      // The plugin publishes one copy for the pull request and one for its
      // repository. Both have one event key, so the automation runs once.
      const opened = (eventKey: string, repo: string) =>
        [`${repo}#7`, repo].map((identifier) => ({
          eventKey,
          eventType: "pull_request.opened",
          occurredAtMs: Date.now(),
          namespace: "github",
          identifier,
          trustedSummary: "A pull request was opened.",
          data: { pullRequest: 7, repo },
        }));
      const ingestAll = async (events: ReturnType<typeof opened>) => {
        let dispatched = 0;
        for (const event of events) {
          dispatched += (await ingestEventAutomations(event, { queue, teamId }))
            .dispatched;
        }
        return dispatched;
      };
      expect(
        await ingestAll(opened("github:opened-1", "getsentry/junior")),
      ).toBe(1);
      expect(
        await ingestAll(opened("github:opened-2", "getsentry/sentry")),
      ).toBe(0);
      const [sent] = queue.sentRecords();
      const dispatch = await getDispatchRecord(
        sent!.conversationId.replace(/^agent-dispatch:/, ""),
      );
      // Guidance belongs to the event, so a trigger with no resource type
      // gets it too.
      expect(dispatch?.input).toContain("Check the description.");
      expect(dispatch?.input).toContain(
        "About: New pull requests in getsentry/junior",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
