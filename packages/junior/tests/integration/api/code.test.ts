import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CodeChangeInput } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import {
  apiErrorSchema,
  codeOverviewReportSchema,
  codeRepositoryReportSchema,
  conversationFeedSchema,
} from "@/api/schema";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorWorkspaceRepos,
  juniorWorkspaces,
} from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";

describe("code API", () => {
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
          url: "https://github.com/getsentry/junior",
        },
        state: "merged",
        title: "Make code native",
        updatedAt: new Date("2026-08-22T12:00:00.000Z"),
        url: "https://github.com/getsentry/junior/pull/42",
      } satisfies CodeChangeInput;
      await recordCodeChange(fixture.sql.db(), "github", codeChange);
      await recordCodeChange(fixture.sql.db(), "github", codeChange);

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
        costUsd: 0,
        created: 1,
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
      expect(report.repositories).toEqual([
        expect.objectContaining({
          created: 1,
          mergeRate: 1,
          name: "getsentry/junior",
          provider: "github",
        }),
      ]);
      expect(report.repositories[0]?.medianCostUsd).toBeUndefined();
      expect(report.changes).toEqual([
        expect.objectContaining({
          number: 42,
          repository: "getsentry/junior",
          state: "merged",
          title: "Make code native",
        }),
      ]);
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
          url: "https://github.com/getsentry/junior",
        },
        state: "open",
        title: "Fix the dashboard route",
        updatedAt: new Date("2026-08-21T12:00:00.000Z"),
        url: "https://github.com/getsentry/junior/pull/7",
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
});
