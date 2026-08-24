import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { codeOverviewReportSchema } from "@/api/schema";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";

describe("code API", () => {
  test("reports code changes across hosting services", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      await migrateSchema(fixture.sql);
      await recordCodeChange(fixture.sql.db(), "github", {
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
      });

      const response = await createJuniorApi().request(
        "http://localhost/api/code",
      );
      expect(response.status).toBe(200);
      const report = codeOverviewReportSchema.parse(await response.json());
      expect(report.summary).toEqual({
        closed: 0,
        created: 1,
        merged: 1,
        mergeRate: 1,
        open: 0,
      });
      expect(report.repositories).toEqual([
        expect.objectContaining({
          created: 1,
          merged: 1,
          name: "getsentry/junior",
          provider: "github",
        }),
      ]);
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
