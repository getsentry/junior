import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { readLocationDetailFromSql } from "@/api/locations/query";
import { apiErrorSchema, locationDetailReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("location detail API", () => {
  test("reports activity for one location", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        channelName: "proj-alpha",
        conversationId: "slack:C1:detail",
        destination: {
          channelId: "C1",
          platform: "slack",
          teamId: "T1",
        },
        nowMs: Date.parse("2026-06-15T11:00:00.000Z"),
        source: "slack",
        visibility: "public",
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ stoppedAt: new Date("2026-06-15T11:30:00.000Z") });
      const [destination] = await fixture.sql
        .db()
        .select()
        .from(juniorDestinations);
      expect(destination).toBeDefined();

      const detail = await readLocationDetailFromSql(destination?.id ?? "");
      expect(detail).toMatchObject({
        conversations: 1,
        label: "#proj-alpha",
        recentConversations: [
          expect.objectContaining({
            conversationId: "slack:C1:detail",
            status: "done",
          }),
        ],
      });
      expect(detail?.activityDays).toHaveLength(90);
      expect(
        detail?.activityDays.find((day) => day.date === "2026-06-15"),
      ).toMatchObject({ conversations: 1 });

      const response = await createJuniorApi().request(
        `http://localhost/api/locations/${destination?.id}`,
      );
      expect(response.status).toBe(200);
      locationDetailReportSchema.parse(await response.json());

      await store.recordActivity({
        conversationId: "local:web:detail",
        destination: { platform: "local", conversationId: "local:web:detail" },
        nowMs: Date.parse("2026-06-15T11:00:00.000Z"),
        source: "web",
        visibility: "public",
      });
      expect(await readLocationDetailFromSql("dashboard")).toMatchObject({
        conversations: 1,
        label: "Dashboard",
        recentConversations: [
          expect.objectContaining({ conversationId: "local:web:detail" }),
        ],
      });
      const [localDestination] = await fixture.sql
        .db()
        .select()
        .from(juniorDestinations)
        .where(eq(juniorDestinations.provider, "local"));
      expect(
        await readLocationDetailFromSql(localDestination?.id ?? ""),
      ).toBeUndefined();

      const missing = await createJuniorApi().request(
        "http://localhost/api/locations/missing",
      );
      expect(missing.status).toBe(404);
      expect(apiErrorSchema.parse(await missing.json())).toEqual({
        error: "Location not found.",
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
