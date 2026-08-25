import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { CodeChangeInput } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import { codeOverviewReportSchema } from "@/api/schema";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
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
});
