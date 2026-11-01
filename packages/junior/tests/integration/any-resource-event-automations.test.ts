import { createAutomationTool } from "@/chat/automations/tools/create";
import { createUpdateAutomationTool } from "@/chat/automations/tools/update";
import { automationToolContext } from "@/chat/automations/tool-access";
import { githubPlugin } from "@sentry/junior-github";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { getConversationStore } from "@/chat/db";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { EventAutomationRecord } from "@/chat/event-automations/types";
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
          createAutomationTool(automationToolContext(context()), catalog),
          {
            instruction: "Review the new pull request.",
            trigger: { type: "event", ...trigger },
          },
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
      // Event data has a lowercase repo, so the saved filter does too.
      const created = await create(
        { ...trigger, match: { repo: "getsentry/Junior" } },
        "any-pull-request",
      );
      expect(created.automation.trigger).toMatchObject({
        identifier: null,
        resourceType: null,
        match: { repo: "getsentry/junior" },
      });
      const [row] = await fixture.sql
        .db()
        .select()
        .from(juniorAutomations)
        .where(eq(juniorAutomations.id, created.automation.id));
      expect(row?.identifier).toBeNull();
      // The runtime gate skips rows that no tool can save: a broad pull
      // request row with no repo filter, a row whose identifier column and
      // saved trigger disagree, and a row that does not parse. The good row
      // still runs.
      const record = row!.record as EventAutomationRecord;
      await fixture.sql
        .db()
        .insert(juniorAutomations)
        .values([
          {
            ...row!,
            id: "evt_no_repo_filter",
            record: {
              ...record,
              trigger: { ...record.trigger, match: undefined },
            },
          },
          {
            ...row!,
            id: "evt_column_without_identifier",
            record: {
              ...record,
              trigger: {
                ...record.trigger,
                identifier: "getsentry/sentry#7",
                resourceType: "pull_request",
                match: undefined,
              },
            },
          },
          { ...row!, id: "evt_bad_record" },
        ]);
      await fixture.sql
        .db()
        .update(juniorAutomations)
        .set({
          record: sql`jsonb_set(${juniorAutomations.record}, '{task}', 'null'::jsonb)`,
        })
        .where(eq(juniorAutomations.id, "evt_bad_record"));
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

      // An update that leaves out identifier and resourceType keeps them,
      // so it cannot make a trigger broad by omission.
      const one = await create(
        {
          ...trigger,
          identifier: "getsentry/junior#7",
          resourceType: "pull_request",
          label: "getsentry/junior#7",
        },
        "one-pull-request",
      );
      const update = (next: Record<string, unknown>, toolCallId: string) =>
        execute(
          createUpdateAutomationTool(automationToolContext(context()), catalog),
          {
            automationId: one.automation.id,
            trigger: { type: "event", ...next },
          },
          toolCallId,
        ) as Promise<{
          automation: { trigger: Record<string, unknown> };
        }>;
      const edited = { ...trigger, label: "Opened getsentry/junior#7" };
      await expect(update(edited, "keep-identifier")).resolves.toMatchObject({
        automation: {
          trigger: {
            identifier: "getsentry/junior#7",
            resourceType: "pull_request",
          },
        },
      });
      // Only explicit nulls drop them, and then the trigger needs a repo.
      const broad = { ...edited, identifier: null, resourceType: null };
      await expect(update(broad, "drop-identifier")).rejects.toThrow(
        'This trigger needs a "repo" filter (match.repo)',
      );
      await expect(
        update(
          { ...broad, match: { repo: "getsentry/junior" } },
          "drop-identifier-with-repo",
        ),
      ).resolves.toMatchObject({
        automation: { trigger: { identifier: null, resourceType: null } },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
