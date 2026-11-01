import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  findActorIdentityId,
  resolveActorIdentityId,
  SYSTEM_IDENTITY_ID,
} from "@/chat/identities/actor";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import {
  readActorIdentityFromSql,
  readIdentityByIdFromSql,
} from "@/chat/plugins/viewer";
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

  it("resolves each actor to one identity", async () => {
    const fixture = await createJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const slack = {
        email: "person@example.com",
        platform: "slack",
        teamId: "T123",
        userId: "U123456",
      } as const;
      expect(await findActorIdentityId(db, slack)).toBeUndefined();
      const slackId = await resolveActorIdentityId(fixture.sql, slack);
      expect(await findActorIdentityId(db, slack)).toBe(slackId);
      expect(
        (await readActorIdentityFromSql(db, slack))?.identity,
      ).toMatchObject({
        id: slackId,
        provider: "slack",
        providerTenantId: "T123",
        providerSubjectId: "U123456",
      });

      const webId = await resolveActorIdentityId(fixture.sql, {
        email: " Web@Example.com ",
        platform: "web",
        userId: "dashboard:abc",
      });
      expect(
        (await readIdentityByIdFromSql(db, webId!))?.identity,
      ).toMatchObject({
        provider: "junior",
        providerSubjectId: "web@example.com",
      });
      expect(
        await resolveActorIdentityId(fixture.sql, {
          platform: "web",
          userId: "dashboard:abc",
        }),
      ).toBeUndefined();

      // Every system and local actor shares one system identity, which has no
      // viewer.
      const systemId = await resolveActorIdentityId(fixture.sql, {
        name: "scheduled-automation",
        platform: "system",
      });
      expect(systemId).toBe(SYSTEM_IDENTITY_ID);
      const local = { platform: "local", userId: "local-cli" } as const;
      expect(await resolveActorIdentityId(fixture.sql, local)).toBe(systemId);
      expect(
        await resolveActorIdentityId(fixture.sql, {
          name: "event",
          platform: "system",
        }),
      ).toBe(systemId);
      expect(await readActorIdentityFromSql(db, local)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
