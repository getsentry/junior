import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { peopleSearchReportSchema, userSearchReportSchema } from "@/api/schema";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createSpace } from "@/chat/spaces/store";
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
    // Only a User can be Invited: a Slack person without an email has none.
    expect(people[0]).not.toHaveProperty("hasUser");
    expect(people[1]).toMatchObject({ hasUser: true });
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

/** A Slack person who is a User, with a verified email. */
async function slackUser(args: {
  email: string;
  fullName: string;
  teamId?: string;
  userId: string;
  userName?: string;
}) {
  await resolveActorIdentityId(getSqlExecutor(), {
    email: args.email,
    fullName: args.fullName,
    platform: "slack",
    teamId: args.teamId ?? "T1",
    userId: args.userId,
    ...(args.userName ? { userName: args.userName } : undefined),
  });
}

/** The people picker search as one signed-in person. */
async function userSearch(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const request = (params: Record<string, string>) =>
    app.request(
      `http://localhost/api/people/user-search?${new URLSearchParams(params)}`,
    );
  return {
    app,
    request,
    viewer,
    async users(params: Record<string, string>) {
      const response = await request(params);
      expect(response.status).toBe(200);
      return userSearchReportSchema.parse(await response.json()).users;
    },
  };
}

describe("user search API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("ranks exact, then prefix, then substring matches, and returns only picker fields", async () => {
    const viewer = await userSearch("ana@example.com");
    const space = await createSpace({
      creatorUserId: viewer.viewer.id,
      description: null,
      name: "Launch",
      visibility: "private",
    });
    await slackUser({
      email: "lucas@example.com",
      fullName: "Bob Lucase",
      userId: "ULUCAS",
    });
    await slackUser({
      email: "zed@example.com",
      fullName: "Zed Case",
      userId: "UZED",
    });
    await slackUser({
      email: "casey@example.com",
      fullName: "Casey Nguyen",
      userId: "UCASEY",
      userName: "casey",
    });
    await slackUser({
      email: "c@example.org",
      fullName: "Cora Smith",
      userId: "UCORA",
      userName: "case",
    });
    // In Slack but not a User: the picker cannot add them.
    await slackPerson({ fullName: "Casey Nobody", userId: "UNOBODY" });
    const search = (q: string, extra: Record<string, string> = {}) =>
      viewer.users({ q, spaceId: space.id, ...extra });

    const ranked = await expectSqlBudget(() => search("case"), {
      // Space access, the search, and photos.
      statements: 4,
      serialRounds: 3,
    });
    expect(ranked.map((user) => user.fullName)).toEqual([
      // Handle is exactly `case`.
      "Cora Smith",
      // Name starts with it, then a word of the name starts with it.
      "Casey Nguyen",
      "Zed Case",
      // Only inside a word.
      "Bob Lucase",
    ]);
    expect(Object.keys(ranked[1]!).sort()).toEqual([
      "email",
      "fullName",
      "slackUserName",
      "userId",
    ]);
    expect(ranked[1]).toMatchObject({
      email: "casey@example.com",
      slackUserName: "casey",
    });
    // A partial email and a handle with `@` match too.
    expect((await search("example.org")).map((user) => user.fullName)).toEqual([
      "Cora Smith",
    ]);
    expect((await search("@casey")).map((user) => user.fullName)).toEqual([
      "Casey Nguyen",
    ]);
    // Every word must match.
    expect((await search("zed ca")).map((user) => user.fullName)).toEqual([
      "Zed Case",
    ]);
    // The viewer is already a Member.
    expect(await search("ana")).toEqual([
      expect.objectContaining({ email: "ana@example.com", isMember: true }),
    ]);
  });

  it("returns ten Users unless asked for fewer, up to a hard cap", async () => {
    const viewer = await userSearch("ana@example.com");
    const space = await createSpace({
      creatorUserId: viewer.viewer.id,
      description: null,
      name: "Launch",
      visibility: "public",
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        slackUser({
          email: `team${index}@example.com`,
          fullName: `Team ${String(index).padStart(2, "0")}`,
          userId: `UTEAM${index}`,
        }),
      ),
    );

    expect(await viewer.users({ q: "team", spaceId: space.id })).toHaveLength(
      10,
    );
    const three = await viewer.users({
      limit: "3",
      q: "team",
      spaceId: space.id,
    });
    expect(three.map((user) => user.fullName)).toEqual([
      "Team 00",
      "Team 01",
      "Team 02",
    ]);
    const tooMany = await viewer.request({
      limit: "26",
      q: "team",
      spaceId: space.id,
    });
    expect(tooMany.status).toBe(400);
    // A search names exactly one place to add people to.
    expect((await viewer.request({ q: "team" })).status).toBe(400);
  });

  it("finds only Users for a place the viewer can read, in its Slack workspace", async () => {
    const owner = await userSearch("ana@example.com");
    const outsider = await userSearch("ben@example.com");
    const space = await createSpace({
      creatorUserId: owner.viewer.id,
      description: null,
      name: "Secret",
      visibility: "private",
    });
    await slackUser({
      email: "casey@example.com",
      fullName: "Casey Nguyen",
      userId: "UCASEY",
    });
    await slackUser({
      email: "casey@example.com",
      fullName: "Casey Nguyen",
      teamId: "T2",
      userId: "UCASEY2",
    });
    await slackUser({
      email: "cam@example.com",
      fullName: "Cam Lee",
      userId: "UCAM",
    });
    await getConversationStore().recordActivity({
      conversationId: "slack:C2:1.0",
      destination: { channelId: "C2", platform: "slack", teamId: "T2" },
      nowMs: 1_000,
      source: "internal",
      title: "Second workspace",
      visibility: "public",
    });
    await getConversationStore().recordActivity({
      conversationId: "slack:C3:1.0",
      destination: { channelId: "C3", platform: "slack", teamId: "T1" },
      nowMs: 1_000,
      source: "internal",
      title: "Private",
      visibility: "private",
    });

    // A private Space or Conversation that the viewer cannot read looks
    // missing, so its members do not leak.
    expect(
      (await outsider.request({ q: "ca", spaceId: space.id })).status,
    ).toBe(404);
    expect(
      (await owner.request({ conversationId: "slack:C3:1.0", q: "ca" })).status,
    ).toBe(404);
    // Only people of the Conversation's workspace, with their Slack id there.
    const invited = await owner.app.request(
      "http://localhost/api/conversations/slack:C2:1.0/invites",
      {
        body: JSON.stringify({ slackUserId: "UCASEY2" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(invited.status).toBe(200);
    expect(
      await owner.users({ conversationId: "slack:C2:1.0", q: "ca" }),
    ).toEqual([
      {
        email: "casey@example.com",
        fullName: "Casey Nguyen",
        isMember: true,
        slackUserId: "UCASEY2",
        userId: expect.any(String),
      },
    ]);
  });

  it("requires a signed-in viewer", async () => {
    const app = new Hono<JuniorApiEnv>();
    app.route("/", createJuniorApi());
    const response = await app.request(
      "http://localhost/api/people/user-search?q=ca&spaceId=6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21",
    );
    expect(response.status).toBe(401);
  });
});
