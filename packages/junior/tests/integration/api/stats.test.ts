import { afterEach, describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { statsReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { incrementStat } from "@/stats";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";

describe("stats API", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("increments and serves daily namespaced counters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await incrementStat({
        namespace: "junior",
        metric: "skill_load",
        name: "junior-qa",
      });
      await incrementStat({
        namespace: "junior",
        metric: "skill_load",
        name: "junior-qa",
      });
      await incrementStat(
        {
          namespace: "github",
          metric: "skill_load",
          name: "review-pr",
        },
        { nowMs: Date.parse("2026-07-27T23:00:00.000Z") },
      );

      const response = await createJuniorApi().request(
        "http://localhost/api/stats",
      );
      expect(response.status).toBe(200);
      const report = statsReportSchema.parse(await response.json());

      expect(report).toMatchObject({
        windowEnd: "2026-07-28",
        windowStart: "2026-04-30",
        stats: [
          {
            count: 1,
            date: "2026-07-27",
            metric: "skill_load",
            name: "review-pr",
            namespace: "github",
          },
          {
            count: 2,
            date: "2026-07-28",
            metric: "skill_load",
            name: "junior-qa",
            namespace: "junior",
          },
        ],
      });
    } finally {
      await fixture.close();
    }
  });
});
