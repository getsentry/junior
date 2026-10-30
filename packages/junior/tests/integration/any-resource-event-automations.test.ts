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
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";
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

      // A new trigger with an identifier is saved as the filters that select
      // the same events, so the tools stop writing identifiers.
      const onePullRequestTrigger = {
        ...trigger,
        identifier: "getsentry/junior#7",
        resourceType: "pull_request",
        label: "getsentry/junior#7",
      };
      const one = await create(onePullRequestTrigger, "one-pull-request");
      const onePullRequest = {
        identifier: null,
        resourceType: null,
        match: { repo: "getsentry/junior", pullRequest: 7 },
      };
      expect(one.automation.trigger).toMatchObject(onePullRequest);
      // A saved list that has the identifier's value becomes that value. A
      // filter that never matches the identifier would never run, so the
      // write fails and names the filter.
      await expect(
        create(
          { ...onePullRequestTrigger, match: { pullRequest: [7, 8] } },
          "list-filter",
        ),
      ).resolves.toMatchObject({ automation: { trigger: onePullRequest } });
      await expect(
        create(
          { ...onePullRequestTrigger, match: { pullRequest: 5 } },
          "conflicting-filter",
        ),
      ).rejects.toThrow(
        'The "pullRequest" filter never matches the events of identifier "getsentry/junior#7"',
      );

      // The converted trigger runs for its pull request and not for another
      // one in the same repository.
      const dispatchedFor = async (pullRequest: number) => {
        const before = queue.sentRecords().length;
        for (const identifier of [
          `getsentry/junior#${pullRequest}`,
          "getsentry/junior",
        ]) {
          await ingestEventAutomations(
            {
              eventKey: `github:one-pull-request-${pullRequest}`,
              eventType: "pull_request.opened",
              occurredAtMs: Date.now(),
              namespace: "github",
              identifier,
              trustedSummary: "A pull request was opened.",
              data: { pullRequest, repo: "getsentry/junior" },
            },
            { queue, teamId },
          );
        }
        let count = 0;
        for (const sentRecord of queue.sentRecords().slice(before)) {
          const dispatched = await getDispatchRecord(
            sentRecord.conversationId.replace(/^agent-dispatch:/, ""),
          );
          if (dispatched?.metadata?.eventAutomationId === one.automation.id) {
            count++;
          }
        }
        return count;
      };
      expect(await dispatchedFor(7)).toBe(1);
      expect(await dispatchedFor(8)).toBe(0);

      // An update changes only the filters that it names. A filter that it
      // leaves out keeps its saved value, so the scope stays. Only null
      // removes a filter.
      const update = (next: Record<string, unknown>, toolCallId: string) =>
        execute(
          createUpdateEventAutomationTool(context(), catalog),
          { automationId: one.automation.id, trigger: next },
          toolCallId,
        ) as Promise<{
          automation: { trigger: Record<string, unknown> };
        }>;
      const edited = { ...trigger, label: "Opened getsentry/junior#7" };
      await expect(update(edited, "keep-filters")).resolves.toMatchObject({
        automation: { trigger: onePullRequest },
      });
      const notDraft = { ...onePullRequest.match, isDraft: false };
      await expect(
        update({ ...edited, match: { isDraft: false } }, "add-filter"),
      ).resolves.toMatchObject({
        automation: { trigger: { match: notDraft } },
      });
      await expect(
        update({ ...edited, match: {} }, "no-filter-change"),
      ).resolves.toMatchObject({
        automation: { trigger: { match: notDraft } },
      });
      await expect(
        update({ ...edited, match: { repo: null } }, "drop-repo"),
      ).rejects.toThrow('This trigger needs a "repo" filter (match.repo)');
      const repoOnly = await update(
        { ...edited, match: { pullRequest: null, isDraft: null } },
        "drop-filters",
      );
      expect(repoOnly.automation.trigger.match).toEqual({
        repo: "getsentry/junior",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);
});
