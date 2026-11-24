import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createApp, defineJuniorPlugins } from "@/app";
import type { CodeChangeInput } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { codePersonReportSchema } from "@/api/schema";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  resolveViewerUser,
  resolveViewerUserFromSql,
} from "@/chat/plugins/viewer";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

function viewerApi(email: string) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error(`missing viewer for ${email}`);
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("people code API", () => {
  // The GitHub plugin builds the code links.
  beforeEach(async () => {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
  });

  test("attributes code changes through conversation actors", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C1:alice",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C1",
        },
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        source: "slack",
        visibility: "public",
        nowMs: Date.parse("2026-08-20T10:00:00.000Z"),
      });
      await store.recordActivity({
        conversationId: "slack:C1:bob",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C1",
        },
        actor: {
          email: "bob@example.com",
          fullName: "Bob Example",
          platform: "slack",
          slackUserId: "U2",
          teamId: "T1",
        },
        source: "slack",
        visibility: "public",
        nowMs: Date.parse("2026-08-21T10:00:00.000Z"),
      });

      const aliceChange = {
        conversationIds: ["slack:C1:alice"],
        mergedAt: new Date("2026-08-22T12:00:00.000Z"),
        number: 11,
        openedAt: new Date("2026-08-20T12:00:00.000Z"),
        providerId: "change-alice",
        repository: {
          name: "getsentry/junior",
          providerId: "repository-1",
        },
        state: "merged",
        title: "Alice change",
        updatedAt: new Date("2026-08-22T12:00:00.000Z"),
      } satisfies CodeChangeInput;
      const bobChange = {
        conversationIds: ["slack:C1:bob"],
        number: 12,
        openedAt: new Date("2026-08-21T12:00:00.000Z"),
        providerId: "change-bob",
        repository: {
          name: "getsentry/junior",
          providerId: "repository-1",
        },
        state: "open",
        title: "Bob change",
        updatedAt: new Date("2026-08-21T12:00:00.000Z"),
      } satisfies CodeChangeInput;
      const aliceStaleChange = {
        conversationIds: ["slack:C1:alice"],
        number: 10,
        openedAt: new Date("2026-05-01T12:00:00.000Z"),
        providerId: "change-alice-stale",
        repository: {
          name: "getsentry/junior",
          providerId: "repository-1",
        },
        state: "open",
        title: "Alice stale change",
        updatedAt: new Date("2026-05-01T12:00:00.000Z"),
      } satisfies CodeChangeInput;
      // Updated last, but opened after the stale change's latest activity.
      const aliceFreshChange = {
        ...aliceStaleChange,
        number: 13,
        openedAt: new Date("2026-08-24T08:00:00.000Z"),
        providerId: "change-alice-fresh",
        title: "Alice fresh change",
        updatedAt: new Date("2026-08-24T08:00:00.000Z"),
      } satisfies CodeChangeInput;
      await recordCodeChange(fixture.sql.db(), "github", aliceChange);
      await recordCodeChange(fixture.sql.db(), "github", aliceStaleChange);
      await recordCodeChange(fixture.sql.db(), "github", aliceFreshChange);
      await recordCodeChange(fixture.sql.db(), "github", bobChange);
      const codeChanges = createPluginCodeChanges("github");
      const activity = { number: 10, repositoryProviderId: "repository-1" };
      await codeChanges.recordActivity({
        ...activity,
        at: new Date("2026-08-23T09:00:00.000Z"),
      });
      // Late webhook deliveries do not move activity back in time.
      await codeChanges.recordActivity({
        ...activity,
        at: new Date("2026-08-01T09:00:00.000Z"),
      });

      const response = await createJuniorApi().request(
        "http://localhost/api/people/alice@example.com/code",
      );
      expect(response.status).toBe(200);
      const report = codePersonReportSchema.parse(await response.json());
      expect(report.summary).toEqual({
        closed: 0,
        costUsd: 0,
        created: 2,
        idle: 0,
        medianMergeTimeMs: 2 * 24 * 60 * 60 * 1_000,
        merged: 1,
        mergeRate: 1,
        open: 2,
      });
      // Open changes come first, longest idle first, by activity or opening.
      expect(report.changes).toEqual([
        expect.objectContaining({
          lastActivityAt: "2026-08-23T09:00:00.000Z",
          number: 10,
          state: "open",
        }),
        expect.objectContaining({ number: 13, state: "open" }),
        expect.objectContaining({
          number: 11,
          repository: "getsentry/junior",
          state: "merged",
          title: "Alice change",
          url: "https://github.com/getsentry/junior/pull/11",
        }),
      ]);
      expect(report.activityDays).toHaveLength(90);
      expect(report.activityDays.at(-3)).toEqual({
        closed: 0,
        created: 0,
        date: "2026-08-22",
        merged: 1,
      });

      // A person with no User gets an empty report.
      const unknown = await createJuniorApi().request(
        "http://localhost/api/people/nobody@example.com/code",
      );
      expect(unknown.status).toBe(200);
      expect(
        codePersonReportSchema.parse(await unknown.json()).summary,
      ).toEqual({ closed: 0, created: 0, idle: 0, merged: 0, open: 0 });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("names the source of each change that the reader may read", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      const actor = {
        email: "alice@example.com",
        fullName: "Alice Example",
        platform: "slack" as const,
        slackUserId: "U1",
        teamId: "T1",
      };
      const channel = {
        channelId: "C1",
        platform: "slack" as const,
        teamId: "T1",
      };
      const nowMs = Date.now();
      await store.recordActivity({
        actor,
        conversationId: "slack:C1:fix",
        nowMs: nowMs - 3_000,
        destination: channel,
        source: "slack",
        title: "Fix the flaky deploy",
        visibility: "public",
      });
      await store.recordActivity({
        actor,
        conversationId: "slack:D1:secret",
        nowMs: nowMs - 2_000,
        destination: { channelId: "D1", platform: "slack", teamId: "T1" },
        source: "slack",
        title: "Private plans",
        visibility: "private",
      });
      await store.recordActivity({
        actor,
        conversationId: "agent-dispatch:sweep-run",
        destination: channel,
        nowMs: nowMs - 1_000,
        title: "Dependency sweep run",
        visibility: "public",
      });
      const user = await resolveViewerUserFromSql(
        fixture.sql.db(),
        "alice@example.com",
      );
      await saveScheduledAutomation(fixture.sql.db(), {
        id: "sched_sweep",
        conversationAccess: { audience: "channel", visibility: "public" },
        createdAtMs: nowMs - 60_000,
        createdBy: { slackUserId: "U1" },
        creatorIdentityId: user!.identities.find(
          (identity) => identity.provider === "slack",
        )!.id,
        credentialMode: "creator",
        destination: channel,
        nextRunAtMs: nowMs + 60_000,
        outcomes: [],
        schedule: {
          description: "",
          kind: "recurring",
          recurrence: {
            frequency: "daily",
            interval: 1,
            startDate: new Date(nowMs).toISOString().slice(0, 10),
            time: { hour: 12, minute: 0 },
          },
          timezone: "UTC",
        },
        status: "active",
        // Untitled, so it is named from its task.
        task: { kind: "instruction", instruction: "Bump dependencies." },
        updatedAtMs: nowMs,
      });
      await recordAutomationExecution("sched_sweep", {
        conversationId: "agent-dispatch:sweep-run",
        executionId: "sweep-run",
        nowMs,
        status: "completed",
      });
      const change = (number: number, ...conversationIds: string[]) =>
        ({
          conversationIds,
          number,
          openedAt: new Date(nowMs - number * 60_000),
          providerId: `change-${number}`,
          repository: {
            name: "getsentry/junior",
            providerId: "repository-1",
          },
          state: "open",
          title: `Change ${number}`,
          updatedAt: new Date(nowMs - number * 60_000),
        }) satisfies CodeChangeInput;
      await recordCodeChange(
        fixture.sql.db(),
        "github",
        change(1, "slack:C1:fix"),
      );
      await recordCodeChange(
        fixture.sql.db(),
        "github",
        change(2, "slack:D1:secret"),
      );
      await recordCodeChange(
        fixture.sql.db(),
        "github",
        change(3, "agent-dispatch:sweep-run"),
      );
      // The earliest Conversation is the source, not the first id.
      await recordCodeChange(
        fixture.sql.db(),
        "github",
        change(4, "slack:C1:fix", "agent-dispatch:sweep-run"),
      );
      const stacks = async (api: {
        request(url: string): Response | Promise<Response>;
      }) =>
        Object.fromEntries(
          codePersonReportSchema
            .parse(
              await (
                await api.request(
                  "http://localhost/api/people/alice@example.com/code",
                )
              ).json(),
            )
            .changes.map((entry) => [entry.number, entry.stack]),
        );

      // A participant reads the private source too.
      expect(await stacks(viewerApi("alice@example.com"))).toEqual({
        1: {
          id: "slack:C1:fix",
          kind: "conversation",
          title: "Fix the flaky deploy",
        },
        2: {
          id: "slack:D1:secret",
          kind: "conversation",
          title: "Private plans",
        },
        3: {
          id: "sched_sweep",
          kind: "automation",
          title: "Bump dependencies.",
        },
        4: {
          id: "slack:C1:fix",
          kind: "conversation",
          title: "Fix the flaky deploy",
        },
      });
      // Anyone else gets no stack for a private source, so its title stays
      // hidden.
      expect((await stacks(createJuniorApi()))[2]).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
