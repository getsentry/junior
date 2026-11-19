import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { peopleSearchReportSchema } from "@/api/schema";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { expectSqlBudget } from "../../../fixtures/sql-budget";

/** A dashboard API signed in as one person. */
async function signedIn(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return async (query: string, conversationId?: string) => {
    const params = new URLSearchParams({
      q: query,
      ...(conversationId ? { conversationId } : undefined),
    });
    const response = await app.request(
      `http://localhost/api/people/search?${params}`,
    );
    expect(response.status).toBe(200);
    return peopleSearchReportSchema.parse(await response.json()).people;
  };
}

async function slackPerson(args: {
  email?: string;
  fullName: string;
  teamId?: string;
  userId: string;
}) {
  await resolveActorIdentityId(getSqlExecutor(), {
    ...(args.email ? { email: args.email } : undefined),
    fullName: args.fullName,
    platform: "slack",
    teamId: args.teamId ?? "T1",
    userId: args.userId,
  });
}

describe("people search API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("finds Slack people by word prefixes of their name", async () => {
    await slackPerson({
      email: "burak@example.com",
      fullName: "Burak Kaya",
      userId: "UBURAK",
    });
    // The same person in a second Slack workspace shows once.
    await slackPerson({
      email: "burak@example.com",
      fullName: "Burak Kaya",
      teamId: "T2",
      userId: "UBURAK2",
    });
    await slackPerson({ fullName: "Bob Builder", userId: "UBOB" });
    await slackPerson({ fullName: "Ana Silva", userId: "UANA" });
    const search = await signedIn("ana@example.com");

    const people = await expectSqlBudget(() => search("bu"), {
      statements: 2,
      serialRounds: 2,
    });
    expect(people.map((person) => person.fullName)).toEqual([
      "Bob Builder",
      "Burak Kaya",
    ]);
    expect(people[0]).toMatchObject({ slackUserId: "UBOB" });
    expect((await search("kay")).map((person) => person.fullName)).toEqual([
      "Burak Kaya",
    ]);
    expect(await search("bu ka")).toHaveLength(1);
    expect(await search("silvaa")).toEqual([]);
    // Punctuation is not tsquery syntax.
    expect(await search("&|!")).toEqual([]);
  });

  it("in a Slack conversation, finds only people of its workspace", async () => {
    await slackPerson({ fullName: "Burak Kaya", userId: "UBURAK" });
    await slackPerson({ fullName: "Burak Kaya", teamId: "T2", userId: "UB2" });
    await getConversationStore().recordActivity({
      conversationId: "slack:C2:1.0",
      destination: { channelId: "C2", platform: "slack", teamId: "T2" },
      nowMs: 1_000,
      source: "internal",
      title: "Second workspace",
      visibility: "public",
    });
    const search = await signedIn("ana@example.com");

    expect(
      (await search("bu", "slack:C2:1.0")).map((person) => person.slackUserId),
    ).toEqual(["UB2"]);
  });
});
