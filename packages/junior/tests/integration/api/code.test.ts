import { beforeEach, describe, expect, test, vi } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createApp, defineJuniorPlugins } from "@/app";
import { eq } from "drizzle-orm";
import * as z from "zod";
import type {
  CodeChangeFilter,
  CodeChangeInput,
} from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import {
  apiErrorSchema,
  codeOverviewReportSchema,
  codePersonReportSchema,
  codeRepositoryReportSchema,
  conversationFeedSchema,
} from "@/api/schema";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { recordCodeChange, recordCodeChangeActivity } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorConversations,
  juniorWorkspaceRepos,
  juniorWorkspaces,
} from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../fixtures/sql";

describe("code API", () => {
  // The GitHub plugin builds the code links.
  beforeEach(async () => {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
  });

  test("reports code changes across hosting services", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      await migrateSchema(fixture.sql);
      const codeChange = {
        conversationIds: ["conversation-1"],
        mergedAt: new Date("2026-08-22T12:00:00.000Z"),
        number: 42,
        openedAt: new Date("2026-08-20T12:00:00.000Z"),
        providerId: "change-42",
        repository: {
          name: "getsentry/junior",
          providerId: "repository-1",
        },
        size: { additions: 1204, changedFiles: 12, deletions: 340 },
        state: "merged",
        title: "Make code native",
        updatedAt: new Date("2026-08-22T12:00:00.000Z"),
      } satisfies CodeChangeInput;
      await recordCodeChange(fixture.sql.db(), "github", codeChange);
      // A write without a size keeps the stored one.
      await recordCodeChange(fixture.sql.db(), "github", {
        ...codeChange,
        size: undefined,
      });
      // A change costs its whole linked tree, child Conversations included.
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values([
          buildJuniorSqlConversation({
            conversationId: "conversation-1",
            usage: { cost: { total: 0.5 } },
          }),
          buildJuniorSqlConversation({
            conversationId: "conversation-1-child",
            parentConversationId: "conversation-1",
            rootConversationId: "conversation-1",
            usage: { cost: { input: 0.1, output: 0.15 } },
          }),
        ]);

      const repositories = await fixture.sql
        .db()
        .select()
        .from(juniorCodeRepositories);
      const changes = await fixture.sql.db().select().from(juniorCodeChanges);
      expect(repositories).toHaveLength(1);
      expect(changes).toHaveLength(1);
      expect(z.string().uuid().parse(repositories[0]?.id)).toBe(
        repositories[0]?.id,
      );
      expect(z.string().uuid().parse(changes[0]?.id)).toBe(changes[0]?.id);
      expect(repositories[0]?.providerId).toBe("repository-1");
      expect(changes[0]).toMatchObject({
        providerId: "change-42",
        repositoryId: repositories[0]?.id,
      });

      const response = await createJuniorApi().request(
        "http://localhost/api/code",
      );
      expect(response.status).toBe(200);
      const report = codeOverviewReportSchema.parse(await response.json());
      expect(report.summary).toEqual({
        closed: 0,
        costUsd: 0.75,
        created: 1,
        idle: 0,
        medianCostUsd: 0.75,
        medianMergeTimeMs: 2 * 24 * 60 * 60 * 1_000,
        merged: 1,
        mergeRate: 1,
        open: 0,
      });
      expect(report.activityDays).toHaveLength(90);
      expect(report.activityDays.at(-3)).toEqual({
        closed: 0,
        created: 0,
        date: "2026-08-22",
        merged: 1,
      });
      expect(report.activityDays.at(-5)).toEqual({
        closed: 0,
        created: 1,
        date: "2026-08-20",
        merged: 0,
      });
      expect(report.activityHours).toHaveLength(7 * 24);
      expect(
        report.activityHours?.find((hour) => hour.date === "2026-08-22T12"),
      ).toEqual({ closed: 0, created: 0, date: "2026-08-22T12", merged: 1 });
      // No stored link: the GitHub plugin builds each link from the
      // repository name and the change number.
      expect(report.repositories).toEqual([
        expect.objectContaining({
          created: 1,
          mergeRate: 1,
          name: "getsentry/junior",
          provider: "github",
          url: "https://github.com/getsentry/junior",
        }),
      ]);
      expect(report.repositories[0]?.medianCostUsd).toBe(0.75);
      expect(report.changes).toEqual([
        expect.objectContaining({
          number: 42,
          repository: "getsentry/junior",
          size: { additions: 1204, changedFiles: 12, deletions: 340 },
          state: "merged",
          title: "Make code native",
          url: "https://github.com/getsentry/junior/pull/42",
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("counts and lists code changes by state, past one page", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      await createSqlStore(fixture.sql).recordActivity({
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        conversationId: "slack:C1:alice",
        destination: { channelId: "C1", platform: "slack", teamId: "T1" },
        nowMs: Date.parse("2026-05-01T10:00:00.000Z"),
        source: "slack",
        visibility: "public",
      });
      const change = (number: number, at: string) =>
        ({
          conversationIds: ["slack:C1:alice"],
          number,
          openedAt: new Date(at),
          providerId: `change-${number}`,
          repository: {
            name: "getsentry/junior",
            providerId: "repository-1",
          },
          state: "open",
          title: `Change ${number}`,
          updatedAt: new Date(at),
        }) satisfies CodeChangeInput;
      // More open changes than a page lists, all older than the closed ones.
      // Change 1 is the oldest, so it falls past the limit, and it is the
      // only one with no recent activity.
      for (let number = 1; number <= 105; number += 1) {
        await recordCodeChange(
          db,
          "github",
          change(
            number,
            number === 1
              ? "2026-05-01T12:00:00.000Z"
              : "2026-05-02T12:00:00.000Z",
          ),
        );
        if (number > 1) {
          await recordCodeChangeActivity(db, "github", {
            at: new Date("2026-08-23T12:00:00.000Z"),
            number,
            repositoryProviderId: "repository-1",
          });
        }
      }
      // More closed changes than a page too, all updated at the same time,
      // so the id orders them.
      for (let number = 106; number <= 215; number += 1) {
        await recordCodeChange(db, "github", {
          ...change(number, "2026-08-20T12:00:00.000Z"),
          closedAt: new Date("2026-08-22T12:00:00.000Z"),
          state: "closed",
          updatedAt: new Date("2026-08-22T12:00:00.000Z"),
        });
      }
      const [repository] = await db
        .select()
        .from(juniorCodeRepositories)
        .where(eq(juniorCodeRepositories.providerId, "repository-1"));
      const api = createJuniorApi();

      const report = codeRepositoryReportSchema.parse(
        await (
          await api.request(
            `http://localhost/api/code/repositories/${repository!.id}`,
          )
        ).json(),
      );
      expect(report.changeCounts).toEqual({
        closed: 110,
        merged: 0,
        open: 105,
      });
      expect(report.summary.open).toBe(105);
      expect(report.summary.idle).toBe(1);
      // Without a state, the latest changes list first, as before.
      expect(report.changes).toHaveLength(100);
      expect(report.changes[0]).toMatchObject({ state: "closed" });

      // Each state lists its own changes, past the newer ones.
      const open = codeRepositoryReportSchema.parse(
        await (
          await api.request(
            `http://localhost/api/code/repositories/${repository!.id}?state=open`,
          )
        ).json(),
      );
      expect(open.changeCounts).toEqual(report.changeCounts);
      expect(open.changes).toHaveLength(100);
      expect(new Set(open.changes.map((listed) => listed.state))).toEqual(
        new Set(["open"]),
      );

      const person = codePersonReportSchema.parse(
        await (
          await api.request(
            "http://localhost/api/people/alice@example.com/code",
          )
        ).json(),
      );
      expect(person.summary.open).toBe(105);
      expect(person.changes).toHaveLength(100);
      // Longest idle first. The next page has the freshest open changes.
      expect(person.changes[0]).toMatchObject({ number: 1, state: "open" });
      expect(person.summary.idle).toBe(1);
      expect(person.nextCursor).toBeDefined();
      const page = async (cursor: string) =>
        codePersonReportSchema.parse(
          await (
            await api.request(
              `http://localhost/api/people/alice@example.com/code?cursor=${cursor}`,
            )
          ).json(),
        );
      // The cursor crosses from open to closed changes, then pages the
      // closed ones.
      const next = await page(person.nextCursor!);
      expect(next.changes.map((listed) => listed.state)).toEqual([
        ...Array<string>(5).fill("open"),
        ...Array<string>(95).fill("closed"),
      ]);
      const last = await page(next.nextCursor!);
      expect(last.nextCursor).toBeUndefined();
      expect(last.changes).toHaveLength(15);
      const listed = [...person.changes, ...next.changes, ...last.changes];
      expect(new Set(listed.map((change) => change.number)).size).toBe(215);
      const personOpen = listed.filter((change) => change.state === "open");
      expect(personOpen).toHaveLength(105);
      expect(
        (
          await api.request(
            "http://localhost/api/people/alice@example.com/code?cursor=nope",
          )
        ).status,
      ).toBe(400);
      // A well-formed cursor whose id is not a code change id is bad too.
      const notAnId = Buffer.from(
        JSON.stringify({ id: "nope", updatedAt: new Date().toISOString() }),
      ).toString("base64url");
      expect(
        (
          await api.request(
            `http://localhost/api/people/alice@example.com/code?cursor=${notAnId}`,
          )
        ).status,
      ).toBe(400);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("reports one repository with its conversations and Workspaces", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const store = createSqlStore(fixture.sql);
      const destination = {
        platform: "slack" as const,
        teamId: "T123",
        channelId: "C123",
      };
      for (const [conversationId, title, visibility] of [
        ["slack:C123:linked", "Fix the dashboard route", "public"],
        ["slack:D123:private-linked", "Private route notes", "private"],
        ["slack:C123:other-repository", "Update the docs", "public"],
        ["slack:C123:unlinked", "Unrelated question", "public"],
      ] as const) {
        await store.recordActivity({
          conversationId,
          destination: {
            ...destination,
            channelId: conversationId.split(":")[1]!,
          },
          nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
          title,
          visibility,
        });
      }
      const change = {
        conversationIds: ["slack:C123:linked", "slack:D123:private-linked"],
        number: 7,
        openedAt: new Date("2026-08-21T12:00:00.000Z"),
        providerId: "change-7",
        repository: {
          name: "getsentry/junior",
          providerId: "repository-1",
        },
        state: "open",
        title: "Fix the dashboard route",
        updatedAt: new Date("2026-08-21T12:00:00.000Z"),
      } satisfies CodeChangeInput;
      await recordCodeChange(db, "github", change);
      await recordCodeChange(db, "github", {
        ...change,
        conversationIds: ["slack:C123:other-repository"],
        providerId: "change-8",
        repository: {
          name: "getsentry/sentry-docs",
          providerId: "repository-2",
        },
        title: "Update the docs",
      });
      await db.insert(juniorWorkspaces).values({
        createdAt: new Date(),
        id: "workspace-1",
        name: "junior",
        updatedAt: new Date(),
      });
      await db.insert(juniorWorkspaceRepos).values({
        provider: "github",
        repo: "GetSentry/Junior",
        workspaceId: "workspace-1",
      });
      const [repository] = await db
        .select()
        .from(juniorCodeRepositories)
        .where(eq(juniorCodeRepositories.providerId, "repository-1"));
      const api = createJuniorApi();

      const response = await api.request(
        `http://localhost/api/code/repositories/${repository!.id}`,
      );
      expect(response.status).toBe(200);
      const report = codeRepositoryReportSchema.parse(await response.json());
      expect(report.repository).toEqual({
        id: repository!.id,
        name: "getsentry/junior",
        provider: "github",
        url: "https://github.com/getsentry/junior",
      });
      expect(report.summary).toMatchObject({ created: 1, open: 1 });
      expect(report.changes).toEqual([
        expect.objectContaining({
          number: 7,
          title: "Fix the dashboard route",
        }),
      ]);
      expect(report.workspaces).toEqual([
        { id: "workspace-1", name: "junior" },
      ]);

      const conversations = conversationFeedSchema.parse(
        await (
          await api.request(
            `http://localhost/api/conversations?codeRepositoryId=${repository!.id}`,
          )
        ).json(),
      );
      expect(
        conversations.conversations.map(
          (conversation) => conversation.conversationId,
        ),
      ).toEqual(["slack:C123:linked"]);

      const missing = await api.request(
        "http://localhost/api/code/repositories/00000000-0000-4000-8000-000000000000",
      );
      expect(missing.status).toBe(404);
      expect(apiErrorSchema.parse(await missing.json()).error).toBe(
        "Repository not found.",
      );
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("lets a plugin read its code changes by repository, state, and age, and rename the repository", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const github = createPluginCodeChanges("github");
      const change = (
        number: number,
        state: "closed" | "merged" | "open",
        updatedAt: string,
      ) =>
        github.record({
          closedAt: state === "closed" ? new Date(updatedAt) : undefined,
          conversationIds: [`conversation-${number}`],
          mergedAt: state === "merged" ? new Date(updatedAt) : undefined,
          number,
          openedAt: new Date("2026-08-01T12:00:00.000Z"),
          providerId: `change-${number}`,
          repository: { name: "getsentry/Junior", providerId: "repository-1" },
          state,
          updatedAt: new Date(updatedAt),
        });
      await change(1, "open", "2026-08-03T12:00:00.000Z");
      await change(2, "open", "2026-08-02T12:00:00.000Z");
      await change(3, "merged", "2026-08-04T12:00:00.000Z");
      await createPluginCodeChanges("gitlab").record({
        conversationIds: [],
        number: 1,
        openedAt: new Date("2026-08-01T12:00:00.000Z"),
        providerId: "gitlab-change-1",
        repository: { name: "getsentry/junior", providerId: "gitlab-1" },
        state: "open",
        updatedAt: new Date("2026-08-01T12:00:00.000Z"),
      });
      const numbers = async (filter: CodeChangeFilter) =>
        (await github.list(filter)).map((found) => found.number);

      // A webhook knows the repository name in any case, and the number.
      await expect(
        github.list({ repository: { name: "GETSENTRY/junior", numbers: [3] } }),
      ).resolves.toEqual([
        {
          closedAt: undefined,
          conversationIds: ["conversation-3"],
          mergedAt: new Date("2026-08-04T12:00:00.000Z"),
          number: 3,
          providerId: "change-3",
          repository: { name: "getsentry/Junior", providerId: "repository-1" },
          state: "merged",
        },
      ]);
      // Oldest update first, and only this plugin's code changes.
      await expect(numbers({})).resolves.toEqual([2, 1, 3]);
      await expect(
        numbers({
          state: "open",
          updatedBefore: new Date("2026-08-03T00:00:00.000Z"),
        }),
      ).resolves.toEqual([2]);
      await expect(
        numbers({ conversationIds: ["conversation-1", "conversation-3"] }),
      ).resolves.toEqual([1, 3]);

      // A newer name renames the repository of every code change in it. An
      // older name does not move it back.
      await github.recordRepository({
        name: "getsentry/junior-next",
        providerId: "repository-1",
        updatedAt: new Date("2026-08-06T12:00:00.000Z"),
      });
      await github.recordRepository({
        name: "getsentry/Junior",
        providerId: "repository-1",
        updatedAt: new Date("2026-08-05T12:00:00.000Z"),
      });
      await expect(
        numbers({ repository: { name: "getsentry/junior-next" } }),
      ).resolves.toEqual([2, 1, 3]);
    } finally {
      await fixture.close();
    }
  });
});
