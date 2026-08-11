import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  resolveViewerUserFromSql,
  updateViewerDisplayNameFromSql,
} from "@/chat/plugins/viewer";
import { juniorUsers } from "@/db/schema";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

describe("viewer display name", () => {
  it("persists a display name for the canonical user", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const viewer = await resolveViewerUserFromSql(db, "person@example.com");
      expect(viewer).toBeDefined();

      const updated = await updateViewerDisplayNameFromSql(
        db,
        viewer!.id,
        "Person Example",
      );

      expect(updated?.displayName).toBe("Person Example");
      const rows = await db
        .select({ displayName: juniorUsers.displayName })
        .from(juniorUsers)
        .where(eq(juniorUsers.id, viewer!.id))
        .limit(1);
      expect(rows[0]?.displayName).toBe("Person Example");
    } finally {
      await fixture.close();
    }
  });
});
