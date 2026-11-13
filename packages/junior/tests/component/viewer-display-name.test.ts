import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  resolveViewerUserFromSql,
  updateViewerDisplayNameFromSql,
} from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import { createJuniorSqlFixture } from "../fixtures/sql";

describe("viewer user", () => {
  // Each test has its own database, so the identity cache must start empty.
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("resolves a known user with its linked identities and no new row", async () => {
    const fixture = await createJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const created = await resolveViewerUserFromSql(db, "Person@Example.com");
      expect(created?.identities).toEqual([]);
      const now = new Date();
      await db.insert(juniorIdentities).values(
        ["slack", "github"].map((provider) => ({
          createdAt: now,
          id: `identity-${provider}`,
          kind: "user" as const,
          provider,
          providerSubjectId: `${provider}-subject`,
          updatedAt: now,
          userId: created!.id,
        })),
      );

      const known = await resolveViewerUserFromSql(db, "person@example.com");

      expect(known).toMatchObject({
        email: "Person@Example.com",
        id: created!.id,
        identities: [
          { id: "identity-github", provider: "github" },
          { id: "identity-slack", provider: "slack" },
        ],
      });
      expect(await db.select().from(juniorUsers)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("persists a display name for the canonical user", async () => {
    const fixture = await createJuniorSqlFixture();
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
