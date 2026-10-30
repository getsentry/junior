import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { readIdentityByIdFromSql } from "@/chat/plugins/viewer";
import { createJuniorSqlFixture } from "../fixtures/sql";

describe("identity read", () => {
  it("reads an identity with the accounts its user links later", async () => {
    const fixture = await createJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const slack = await upsertIdentity(fixture.sql, {
        email: "person@example.com",
        emailVerified: true,
        kind: "user",
        provider: "slack",
        providerSubjectId: "U123",
        providerTenantId: "T123",
      });

      const before = await readIdentityByIdFromSql(db, slack.id);
      expect(before?.identity.id).toBe(slack.id);
      expect(before?.user?.identities.map((i) => i.provider)).toEqual([
        "slack",
      ]);

      await upsertLinkedIdentity(fixture.sql, slack.userId!, {
        handle: "person",
        kind: "user",
        provider: "github",
        providerSubjectId: "42",
      });
      const after = await readIdentityByIdFromSql(db, slack.id);
      expect(
        after?.user?.identities.find((i) => i.provider === "github")?.handle,
      ).toBe("person");
      expect(await readIdentityByIdFromSql(db, "missing")).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
