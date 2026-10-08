import { describe, expect, it } from "vitest";
import { runAdmin } from "@/cli/admin";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createJuniorSqlFixture } from "../fixtures/sql";

describe("junior admin CLI", () => {
  it("grants, lists, and revokes the Junior-wide admin role", async () => {
    const fixture = await createJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const lines: string[] = [];
      const errors: string[] = [];
      const io = {
        error: (line: string) => errors.push(line),
        log: (line: string) => lines.push(line),
      };

      // Granting works before the person first signs in.
      await expect(
        runAdmin(["grant", "Person@Example.com"], { db, io }),
      ).resolves.toBe(0);
      await expect(
        resolveViewerUserFromSql(db, "person@example.com"),
      ).resolves.toMatchObject({ isAdmin: true });

      await expect(runAdmin(["list"], { db, io })).resolves.toBe(0);
      expect(lines.at(-1)).toBe("Person@Example.com");

      await expect(
        runAdmin(["revoke", "person@example.com"], { db, io }),
      ).resolves.toBe(0);
      const revoked = await resolveViewerUserFromSql(db, "person@example.com");
      expect(revoked?.isAdmin).toBeUndefined();

      // Revoking an unknown email fails without creating a user.
      await expect(
        runAdmin(["revoke", "nobody@example.com"], { db, io }),
      ).resolves.toBe(1);
      expect(errors).toEqual([
        'No Junior user has the email "nobody@example.com".',
      ]);
      await expect(runAdmin(["grant"], { db, io })).resolves.toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
