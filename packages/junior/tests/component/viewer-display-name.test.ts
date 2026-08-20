import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { upsertIdentity } from "@/chat/identities/sql";
import {
  readActorIdentityFromSql,
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

  it("resolves web actors through junior email identities", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const email = "web-actor@example.com";
      await upsertIdentity(fixture.sql, {
        kind: "user",
        provider: "junior",
        providerSubjectId: email,
        email,
        emailVerified: true,
      });
      await upsertIdentity(fixture.sql, {
        kind: "user",
        provider: "slack",
        providerTenantId: "T123",
        providerSubjectId: "U123",
        email,
        emailVerified: true,
      });

      const resolved = await readActorIdentityFromSql(db, {
        platform: "web",
        // Hash is intentionally not used for lookup; email is authoritative.
        userId: "dashboard:not-the-lookup-key",
        email,
      });

      expect(resolved?.identity).toMatchObject({
        provider: "junior",
        providerSubjectId: email,
      });
      expect(
        resolved?.user?.identities.some(
          (identity) =>
            identity.provider === "slack" &&
            identity.providerTenantId === "T123" &&
            identity.providerSubjectId === "U123",
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
