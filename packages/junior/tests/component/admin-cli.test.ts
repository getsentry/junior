import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdmin } from "@/cli/admin";
import { CLI_USAGE } from "@/cli/run";
import { getDb } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

describe("junior admin CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grants, lists, and revokes the Junior-wide admin role", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await migrateSchema(fixture.sql);

      // Granting works before the person first signs in.
      await expect(runAdmin(["grant", "Person@Example.com"])).resolves.toBe(0);
      await expect(
        resolveViewerUserFromSql(getDb(), "person@example.com"),
      ).resolves.toMatchObject({ isAdmin: true });

      await expect(runAdmin(["list"])).resolves.toBe(0);
      expect(log).toHaveBeenLastCalledWith("Person@Example.com");

      await expect(runAdmin(["revoke", "person@example.com"])).resolves.toBe(0);
      const revoked = await resolveViewerUserFromSql(
        getDb(),
        "person@example.com",
      );
      expect(revoked?.isAdmin).toBeUndefined();

      // Revoking an unknown email fails without creating a user.
      await expect(runAdmin(["revoke", "nobody@example.com"])).resolves.toBe(1);
      expect(error).toHaveBeenLastCalledWith(
        'No Junior user has the email "nobody@example.com".',
      );
      await expect(runAdmin(["grant"])).resolves.toBe(1);
      expect(error).toHaveBeenLastCalledWith(CLI_USAGE);
    } finally {
      await fixture.close();
    }
  });
});
