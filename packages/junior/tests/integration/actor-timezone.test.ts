import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/chat/actor";
import { readUserTimezone, upsertIdentity } from "@/chat/identities/sql";
import { findActorTimezone } from "@/chat/identities/timezone";
import type { JuniorDatabase } from "@/db/db";
import { juniorUsers } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import { queueSlackApiResponse } from "../msw/handlers/slack-api";
import { usersInfoOk } from "../fixtures/slack/factories/api";

const TEAM_ID = `TTZ${Date.now()}`;
let fixture: LocalJuniorSqlFixture;

function db(): JuniorDatabase {
  return fixture.sql.db();
}

function queueSlackTimezone(userId: string, tz: string) {
  queueSlackApiResponse("users.info", { body: usersInfoOk({ userId, tz }) });
}

/** Store a Slack identity and the User that its verified email links. */
async function linkedSlackPerson(slackUserId: string): Promise<string> {
  const identity = await upsertIdentity(fixture.sql, {
    email: `${slackUserId.toLowerCase()}@example.com`,
    emailVerified: true,
    kind: "user",
    provider: "slack",
    providerSubjectId: slackUserId,
    providerTenantId: TEAM_ID,
  });
  return identity.userId!;
}

async function find(actor: Actor, userId?: string) {
  return await findActorTimezone({
    actor,
    db: db(),
    nowMs: Date.now(),
    resolveUserId: async () => userId,
  });
}

describe("asker timezone", () => {
  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("uses a Slack asker's profile and saves it on their user", async () => {
    const userId = await linkedSlackPerson("UTZSLACK");
    queueSlackTimezone("UTZSLACK", "America/New_York");

    await expect(
      find({ platform: "slack", teamId: TEAM_ID, userId: "UTZSLACK" }, userId),
    ).resolves.toBe("America/New_York");
    await expect(readUserTimezone(db(), userId)).resolves.toBe(
      "America/New_York",
    );
  });

  it("uses the linked Slack profile for a web asker", async () => {
    const userId = await linkedSlackPerson("UTZWEB");
    queueSlackTimezone("UTZWEB", "Europe/Vienna");

    await expect(
      find({ platform: "web", userId, email: "utzweb@example.com" }),
    ).resolves.toBe("Europe/Vienna");
    await expect(readUserTimezone(db(), userId)).resolves.toBe("Europe/Vienna");
  });

  it("uses the saved timezone when Slack has none", async () => {
    const userId = await linkedSlackPerson("UTZSAVED");
    await db()
      .update(juniorUsers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(juniorUsers.id, userId));
    queueSlackTimezone("UTZSAVED", "");

    await expect(
      find({ platform: "web", userId, email: "utzsaved@example.com" }),
    ).resolves.toBe("Asia/Tokyo");
  });

  it("returns nothing instead of the install default", async () => {
    const userId = await linkedSlackPerson("UTZNONE");
    queueSlackTimezone("UTZNONE", "");

    await expect(
      find({ platform: "web", userId, email: "utznone@example.com" }),
    ).resolves.toBeUndefined();
    await expect(
      find({ platform: "local", userId: "local-user" }),
    ).resolves.toBeUndefined();
  });
});
