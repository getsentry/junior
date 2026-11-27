import type { Identity } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationDetailReportSchema,
  conversationFeedSchema,
  conversationInviteResponseSchema,
  userSearchReportSchema,
  setConversationSpaceResponseSchema,
  spaceListSchema,
  spaceConfigurationSchema,
  spaceSchema,
  versionsSchema,
} from "@/api/schema";
import { canReadConversation } from "@/api/conversations/access";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { resolveConversationConfiguration } from "@/chat/configuration/conversation";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { createLocationConfigurationService } from "@/chat/configuration/service";
import type {
  ConfigEntry,
  LocationConfigurationService,
  LocationConfigurationStorage,
} from "@/chat/configuration/types";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { getSpaceLead } from "@/chat/lead/conversation";
import { createListSpacesTool } from "@/chat/tools/list-spaces";
import { createMoveConversationToSpaceTool } from "@/chat/tools/move-conversation-to-space";
import { createSetConfigurationTool } from "@/chat/tools/set-configuration";
import { juniorConversationParticipants } from "@/db/schema";
import { closeConversationFixture } from "../../fixtures/conversation";
import {
  apiFor,
  createSpace,
  request,
  send,
  spaceFeed,
  startConversation,
  startThread,
} from "../../fixtures/spaces-api";
import { signedInViewer } from "../../fixtures/user";

async function detail(app: Hono<JuniorApiEnv>, conversationId: string) {
  const response = await request(
    app,
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}`,
  );
  expect(response.status).toBe(200);
  return conversationDetailReportSchema.parse(await response.json());
}

async function detailSpace(app: Hono<JuniorApiEnv>, conversationId: string) {
  return (await detail(app, conversationId)).space;
}

async function detailVersion(app: Hono<JuniorApiEnv>, conversationId: string) {
  const response = await request(
    app,
    "GET",
    `/versions?${new URLSearchParams({ conversationIds: conversationId })}`,
  );
  return versionsSchema.parse(await response.json()).conversationDetails[
    conversationId
  ];
}

async function moveTo(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  spaceId: string | null,
): Promise<Response> {
  return await request(
    app,
    "PUT",
    `/conversations/${encodeURIComponent(conversationId)}/space`,
    { spaceId },
  );
}

/** The id of a Space's Lead, whose Participants are its members. */
async function leadOf(app: Hono<JuniorApiEnv>, spaceId: string) {
  const response = await send(app, "GET", `/${spaceId}`);
  expect(response.status).toBe(200);
  return spaceSchema.parse(await response.json()).leadConversationId;
}

async function leave(app: Hono<JuniorApiEnv>, conversationId: string) {
  return await request(
    app,
    "POST",
    `/conversations/${encodeURIComponent(conversationId)}/leave`,
  );
}

async function postMessage(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  key: string,
) {
  return await request(
    app,
    "POST",
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    { idempotencyKey: key, message: "Hi" },
  );
}

async function listNames(
  app: Hono<JuniorApiEnv>,
  query = "",
): Promise<string[]> {
  const response = await send(app, "GET", query);
  expect(response.status).toBe(200);
  return spaceListSchema
    .parse(await response.json())
    .spaces.map((space) => space.name);
}

/** A Slack channel's configuration, kept in memory. */
function memoryStorage(): LocationConfigurationStorage {
  const entries = new Map<string, ConfigEntry>();
  return {
    get: async (key) => entries.get(key),
    list: async () => [...entries.values()],
    set: async (entry) => {
      entries.set(entry.key, entry);
    },
    unset: async (key) => entries.delete(key),
  };
}

describe("Spaces API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("creates a public Space that others can find, join, and leave", async () => {
    const ana = apiFor("spaces-api-ana@example.com");
    const bo = apiFor("spaces-api-bo@example.com");

    expect((await send(apiFor(), "GET", "")).status).toBe(401);

    const created = await send(ana, "POST", "", {
      name: "  Billing migration ",
      description: "Move billing to the new ledger.",
    });
    expect(created.status).toBe(201);
    const space = spaceSchema.parse(await created.json());
    expect(space).toMatchObject({
      name: "Billing migration",
      description: "Move billing to the new ledger.",
      archivedAt: null,
      memberCount: 1,
      viewerIsMember: true,
    });

    expect(await listNames(ana)).toContain("Billing migration");
    expect(await listNames(bo)).not.toContain("Billing migration");
    expect(await listNames(bo, "?membership=all")).toContain(
      "Billing migration",
    );

    const read = spaceSchema.parse(
      await (await send(bo, "GET", `/${space.id}`)).json(),
    );
    expect(read).toMatchObject({ memberCount: 1, viewerIsMember: false });

    // A mention in the Space's work adds nobody.
    await resolveActorIdentityId(getSqlExecutor(), {
      email: "spaces-api-bo@example.com",
      platform: "slack",
      teamId: "T1",
      userId: "USPACESBO",
    });
    await startConversation(ana, "spaces-api-mention", {
      message: "<@USPACESBO> look",
      spaceId: space.id,
    });
    const readByBo = async () =>
      spaceSchema.parse(await (await send(bo, "GET", `/${space.id}`)).json());
    expect(await readByBo()).toMatchObject({
      memberCount: 1,
      viewerIsMember: false,
    });

    // Only a Participant posts. Bo joins the public Lead himself first.
    const lead = await leadOf(bo, space.id);
    expect((await postMessage(bo, lead, "spaces-api-post")).status).toBe(403);
    expect(await readByBo()).toMatchObject({ viewerIsMember: false });
    expect(await detail(bo, lead)).toHaveProperty("subscribed", false);
    const joined = await request(
      bo,
      "PATCH",
      `/conversations/${encodeURIComponent(lead)}/subscription`,
      { subscribed: true },
    );
    expect(joined.status).toBe(200);
    expect(await readByBo()).toMatchObject({
      memberCount: 2,
      viewerIsMember: true,
    });

    // Leave of the Lead leaves the Space.
    expect((await leave(bo, lead)).status).toBe(200);
    expect(await readByBo()).toMatchObject({
      memberCount: 1,
      viewerIsMember: false,
    });
    expect(await listNames(bo)).not.toContain("Billing migration");

    // Leave of a public Lead keeps Bo a Participant, so he can still post.
    expect((await postMessage(bo, lead, "spaces-api-rejoin")).status).toBe(200);
  });

  it("lets only members rename or archive a Space", async () => {
    const ana = apiFor("spaces-api-owner@example.com");
    const bo = apiFor("spaces-api-visitor@example.com");
    const space = spaceSchema.parse(
      await (await send(ana, "POST", "", { name: "Junior iOS" })).json(),
    );
    expect(space.description).toBeNull();

    expect(
      (await send(bo, "PATCH", `/${space.id}`, { name: "Mine now" })).status,
    ).toBe(403);
    expect(
      (await send(bo, "PATCH", `/${space.id}/archive`, { archived: true }))
        .status,
    ).toBe(403);
    expect((await send(ana, "PATCH", `/${space.id}`, {})).status).toBe(400);

    const renamed = await send(ana, "PATCH", `/${space.id}`, {
      name: "Junior for iOS",
      description: "",
    });
    expect(spaceSchema.parse(await renamed.json())).toMatchObject({
      name: "Junior for iOS",
      description: null,
    });

    // A rename that fails keeps the old description too.
    const sql = getSqlExecutor();
    await sql.query(
      `create function fail_lead_rename() returns trigger language plpgsql as $$ begin raise exception 'rename failed'; end $$`,
    );
    await sql.query(
      `create trigger fail_lead_rename before update of title on junior_conversations for each row execute function fail_lead_rename()`,
    );
    try {
      const failed = await send(ana, "PATCH", `/${space.id}`, {
        name: "Junior on iPad",
        description: "Not saved.",
      });
      expect(failed.status).toBe(500);
    } finally {
      await sql.query(`drop trigger fail_lead_rename on junior_conversations`);
      await sql.query(`drop function fail_lead_rename()`);
    }
    expect(
      spaceSchema.parse(await (await send(ana, "GET", `/${space.id}`)).json()),
    ).toMatchObject({ name: "Junior for iOS", description: null });

    const archived = spaceSchema.parse(
      await (
        await send(ana, "PATCH", `/${space.id}/archive`, { archived: true })
      ).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    // Only a Participant posts, so a reader's Message never restores one.
    expect(
      (await postMessage(bo, await leadOf(bo, space.id), "spaces-api-visit"))
        .status,
    ).toBe(403);
    expect(await listNames(ana)).not.toContain("Junior for iOS");
    expect(await listNames(ana, "?archived=true")).toContain("Junior for iOS");
    const restored = spaceSchema.parse(
      await (
        await send(ana, "PATCH", `/${space.id}/archive`, { archived: false })
      ).json(),
    );
    expect(restored.archivedAt).toBeNull();
  });

  it("returns 404 for a Space that does not exist", async () => {
    const ana = apiFor("spaces-api-missing@example.com");
    expect(
      (await send(ana, "GET", "/00000000-0000-4000-8000-000000000000")).status,
    ).toBe(404);
    expect((await send(ana, "GET", "/not-a-uuid")).status).toBe(400);
  });

  it("starts, lists, and moves Conversations in a Space", async () => {
    const ana = apiFor("spaces-work-ana@example.com");
    const bo = apiFor("spaces-work-bo@example.com");
    const space = await createSpace(ana, "Ledger");
    const other = await createSpace(ana, "Payroll");

    // Only members start work in a Space, and the work is public.
    expect(
      (
        await request(bo, "POST", "/conversations", {
          idempotencyKey: "bo-in-ledger",
          message: "Hi",
          spaceId: space.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(ana, "POST", "/conversations", {
          idempotencyKey: "ana-private",
          message: "Hi",
          spaceId: space.id,
          visibility: "private",
        })
      ).status,
    ).toBe(400);

    const inSpace = await startConversation(ana, "ledger-plan", {
      spaceId: space.id,
    });
    const oneOff = await startConversation(ana, "one-off");
    // Only members post in a Space's Conversations, as in any root.
    expect((await postMessage(bo, inSpace, "bo-in-ledger-plan")).status).toBe(
      403,
    );

    // Anyone can read the public Space's list. Rows and the detail name the
    // Space.
    const rows = await spaceFeed(bo, space.id);
    expect(rows.map((row) => row.conversationId)).toEqual([inSpace]);
    expect(rows[0]?.space).toEqual({ id: space.id, name: "Ledger" });
    expect(await detailSpace(ana, oneOff)).toBeNull();
    // A child is in the Space of its root, and moves only with it.
    const thread = await startThread(inSpace, "local:spaces-work-thread");
    expect(await detailSpace(ana, thread)).toEqual({
      id: space.id,
      name: "Ledger",
    });
    expect((await moveTo(ana, thread, null)).status).toBe(409);
    // A member's own feed lists the Space's work, with its Threads.
    const anaRow = (await spaceFeed(ana, "")).find(
      (row) => row.conversationId === inSpace,
    );
    expect(anaRow?.threads?.map((row) => row.conversationId)).toEqual([thread]);

    // A move writes only the root, and the child's detail token still
    // changes, so an open child detail refreshes its Space.
    const threadVersion = await detailVersion(ana, thread);
    expect((await moveTo(ana, inSpace, other.id)).status).toBe(200);
    expect(await detailVersion(ana, thread)).not.toBe(threadVersion);
    expect((await moveTo(ana, inSpace, space.id)).status).toBe(200);

    // Moving takes membership of both Spaces.
    expect((await moveTo(bo, oneOff, space.id)).status).toBe(404);
    const moved = await moveTo(ana, oneOff, space.id);
    expect(
      setConversationSpaceResponseSchema.parse(await moved.json()),
    ).toEqual({ space: { id: space.id, name: "Ledger" } });
    expect(
      (await spaceFeed(ana, space.id)).map((row) => row.conversationId).sort(),
    ).toEqual([inSpace, oneOff].sort());
    expect((await leave(ana, await leadOf(ana, other.id))).status).toBe(200);
    expect((await moveTo(ana, oneOff, other.id)).status).toBe(403);
    expect(
      setConversationSpaceResponseSchema.parse(
        await (await moveTo(ana, oneOff, null)).json(),
      ),
    ).toEqual({ space: null });
    expect(
      (await spaceFeed(ana, space.id)).map((row) => row.conversationId),
    ).toEqual([inSpace]);

    // Only a root is left or unsubscribed. The Space's work follows its
    // Lead, so its detail offers neither, and both refuse.
    const inSpaceDetail = await detail(ana, inSpace);
    expect(inSpaceDetail).not.toHaveProperty("subscribed");
    const leadId = inSpaceDetail.parentConversationId!;
    for (const [path, body] of [
      ["leave", undefined],
      ["subscription", { subscribed: false }],
    ] as const) {
      const refused = await request(
        ana,
        path === "leave" ? "POST" : "PATCH",
        `/conversations/${encodeURIComponent(inSpace)}/${path}`,
        body,
      );
      expect(refused.status).toBe(409);
    }
    const ownFeed = async () =>
      (await spaceFeed(ana, "")).map((row) => row.conversationId);
    expect(await ownFeed()).toContain(inSpace);

    // Leaving the Lead takes all of the Space's work out of the leaver's
    // feed. The last subscriber leaving never archives it.
    expect(await detail(ana, leadId)).toHaveProperty("subscribed", true);
    const left = await request(
      ana,
      "POST",
      `/conversations/${encodeURIComponent(leadId)}/leave`,
    );
    expect(left.status).toBe(200);
    expect(await left.json()).toEqual({ archivedAt: null });
    expect(await ownFeed()).not.toContain(inSpace);
    expect(
      (await spaceFeed(ana, space.id)).map((row) => row.conversationId),
    ).toEqual([inSpace]);
  });

  it("finds and moves Conversations into, between, and out of Spaces with the agent tools", async () => {
    const ana = apiFor("spaces-tool-ana@example.com");
    const bo = apiFor("spaces-tool-bo@example.com");
    const anaUser = await signedInViewer("spaces-tool-ana@example.com");
    const first = await createSpace(ana, "Tool first");
    const second = await createSpace(ana, "Tool second");
    const conversationId = await startConversation(ana, "tool-move");
    const thread = await startThread(
      conversationId,
      "local:spaces-tool-thread",
    );
    const move = (
      input: { conversation_id?: string; space?: string | null },
      from = thread,
      spaceId?: string,
    ) =>
      createMoveConversationToSpaceTool({
        conversationId: from,
        resolveActorIdentity: async () => ({
          identity: { id: `identity:${anaUser.id}` } as Identity,
          user: anaUser,
        }),
        spaceId,
      }).execute?.(input, {});

    // By a dashboard link, from a Thread of the root.
    expect(
      await move({
        conversation_id: conversationId,
        space: `https://junior.example.com/spaces/${first.id}`,
      }),
    ).toEqual({
      conversation_id: conversationId,
      space: { id: first.id, name: "Tool first" },
    });
    // From one Space to another, by ID.
    expect(
      await move({ conversation_id: conversationId, space: second.id }),
    ).toMatchObject({ space: { id: second.id } });
    expect(await detailSpace(ana, thread)).toMatchObject({ id: second.id });
    // A child stays in the Space of its root.
    await expect(move({ space: first.id })).rejects.toThrow(
      "Only a top-level conversation moves",
    );
    // Names are not unique, so a name is not enough.
    await expect(
      move({ conversation_id: conversationId, space: "Tool first" }),
    ).rejects.toThrow("not a Space ID or a link to a Space");
    // The person must be a member of the Space that it joins.
    const others = await createSpace(bo, "Tool others");
    await expect(
      move({ conversation_id: conversationId, space: others.id }),
    ).rejects.toThrow("Join the Space to add work to it.");
    // A Lead moves it into its own Space with no Space named.
    const lead = await getSpaceLead(first.id);
    expect(
      await move(
        { conversation_id: conversationId },
        lead.conversationId,
        first.id,
      ),
    ).toMatchObject({ space: { id: first.id } });
    await expect(move({ conversation_id: conversationId })).rejects.toThrow(
      "This conversation is in no Space.",
    );
    expect(
      await move({ conversation_id: conversationId, space: null }),
    ).toMatchObject({ space: null });
    // A conversation in a private Space stays in it.
    const hidden = spaceSchema.parse(
      await (
        await send(ana, "POST", "", {
          name: "Tool private",
          visibility: "private",
        })
      ).json(),
    );
    await move({ conversation_id: conversationId, space: hidden.id });
    await expect(
      move({ conversation_id: conversationId, space: null }),
    ).rejects.toThrow("A conversation in a private Space stays in it.");

    // The person finds every public Space, and a private one only from a
    // conversation in it.
    const list = (input: { membership?: "all" | "member" }, spaceId?: string) =>
      createListSpacesTool({
        resolveActorIdentity: async () => ({
          identity: { id: `identity:${anaUser.id}` } as Identity,
          user: anaUser,
        }),
        spaceId,
      }).execute?.(input, {}) as Promise<{
        spaces: { id: string; member: boolean }[];
      }>;
    expect((await list({})).spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, member: true }),
        expect.objectContaining({ id: others.id, member: false }),
      ]),
    );
    expect((await list({})).spaces.map((space) => space.id)).not.toContain(
      hidden.id,
    );
    expect(
      (await list({ membership: "member" })).spaces.map((space) => space.id),
    ).not.toContain(others.id);
    expect(
      (await list({}, hidden.id)).spaces.map((space) => space.id),
    ).toContain(hidden.id);
  });

  it("keeps a private Space and its Conversations with its members", async () => {
    const ana = apiFor("spaces-private-ana@example.com");
    const bo = apiFor("spaces-private-bo@example.com");
    const cy = apiFor("spaces-private-cy@example.com");
    const created = await send(ana, "POST", "", {
      name: "Payroll audit",
      visibility: "private",
    });
    expect(created.status).toBe(201);
    const space = spaceSchema.parse(await created.json());
    expect(space.visibility).toBe("private");

    // A person who is not a member cannot find, read, or join it.
    expect(await listNames(bo, "?membership=all")).not.toContain(
      "Payroll audit",
    );
    expect((await send(bo, "GET", `/${space.id}`)).status).toBe(404);
    const lead = await leadOf(ana, space.id);
    expect((await postMessage(bo, lead, "payroll-bo-join")).status).toBe(403);

    // Its Conversations take its visibility, and only members read them.
    expect(
      (
        await request(ana, "POST", "/conversations", {
          idempotencyKey: "payroll-public",
          message: "Hi",
          spaceId: space.id,
          visibility: "public",
        })
      ).status,
    ).toBe(400);
    const inSpace = await startConversation(ana, "payroll-plan", {
      spaceId: space.id,
    });
    const oneOff = await startConversation(ana, "payroll-one-off");
    const spaceRef = { id: space.id, name: "Payroll audit" };
    expect(await detailSpace(bo, inSpace)).toBeNull();
    // Its change token does not carry the Space's name either.
    expect(await detailVersion(bo, inSpace)).not.toContain("Payroll audit");
    expect(await spaceFeed(bo, space.id)).toEqual([]);

    // A member finds a User, who may have no Slack account, and invites
    // them to the Lead. Then every member reads every Conversation.
    const invite = (app: Hono<JuniorApiEnv>, userId: string) =>
      request(
        app,
        "POST",
        `/conversations/${encodeURIComponent(lead)}/invites`,
        { userId },
      );
    const found = userSearchReportSchema.parse(
      await (
        await request(
          ana,
          "GET",
          `/people/user-search?${new URLSearchParams({ conversationId: lead, q: "spaces-private-bo" })}`,
        )
      ).json(),
    ).users;
    expect(found).toEqual([
      expect.objectContaining({ email: "spaces-private-bo@example.com" }),
    ]);
    const boUserId = found[0]!.userId;
    expect((await invite(bo, boUserId)).status).toBe(404);
    expect((await invite(ana, "missing-user")).status).toBe(404);
    const added = await invite(ana, boUserId);
    expect(conversationInviteResponseSchema.parse(await added.json())).toEqual({
      added: true,
    });
    expect(
      spaceSchema.parse(await (await send(ana, "GET", `/${space.id}`)).json())
        .memberCount,
    ).toBe(2);
    expect(await detail(bo, inSpace)).toMatchObject({
      space: spaceRef,
      visibility: "private",
    });
    expect(
      (await spaceFeed(bo, space.id)).map((row) => row.conversationId),
    ).toEqual([inSpace]);

    // Data stays in the Space: Conversations in it read each other, and a
    // Conversation outside it reads none of them.
    expect((await moveTo(ana, oneOff, space.id)).status).toBe(200);
    expect(await detail(ana, oneOff)).toMatchObject({ visibility: "private" });
    expect(await canReadConversation(getDb(), oneOff, inSpace)).toBe(true);
    const outside = await startConversation(ana, "payroll-outside");
    expect(await canReadConversation(getDb(), outside, inSpace)).toBe(false);
    expect(await canReadConversation(getDb(), inSpace, outside)).toBe(true);
    expect((await moveTo(ana, oneOff, null)).status).toBe(409);

    // A Space keeps the visibility it was created with.
    expect(
      (await send(ana, "PATCH", `/${space.id}`, { visibility: "public" }))
        .status,
    ).toBe(400);
    expect(await detailSpace(cy, inSpace)).toBeNull();

    // A member who leaves the Lead no longer finds its Conversations.
    const inbox = async () =>
      conversationFeedSchema
        .parse(await (await request(bo, "GET", "/conversations")).json())
        .conversations.map((row) => row.conversationId);
    expect(await inbox()).toContain(inSpace);
    expect((await leave(bo, lead)).status).toBe(200);
    expect(await inbox()).not.toContain(inSpace);
    expect(await detailSpace(bo, inSpace)).toBeNull();
  });

  it("keeps a Slack Conversation out of a private Space", async () => {
    const ana = apiFor("spaces-slack-ana@example.com");
    const conversationId = "slack:CSPACES:1700000000.000100";
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "slack", teamId: "T123", channelId: "CSPACES" },
      nowMs: 1_000,
      source: "slack",
      visibility: "public",
    });
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1_000),
        rootConversationId: conversationId,
        userId: (await signedInViewer("spaces-slack-ana@example.com")).id,
      });

    const hidden = spaceSchema.parse(
      await (
        await send(ana, "POST", "", {
          name: "Support escalations",
          visibility: "private",
        })
      ).json(),
    );
    expect((await moveTo(ana, conversationId, hidden.id)).status).toBe(409);
  });

  it("lets members ask Junior to set the configuration that a Space's Conversations use", async () => {
    const ana = apiFor("spaces-config-ana@example.com");
    const bo = apiFor("spaces-config-bo@example.com");
    const space = await createSpace(ana, "Configured");
    const inSpace = await startConversation(ana, "configured-work", {
      spaceId: space.id,
    });
    const thread = await startThread(inSpace, "local:spaces-config-thread");
    const outside = await startConversation(ana, "unconfigured-work");
    const setting = async (
      email: string,
      conversationId: string,
      input: { key: string; value: string | null },
      extra: {
        configuration?: Record<string, unknown>;
        locationConfiguration?: LocationConfigurationService;
      } = {},
    ) => {
      const user = await signedInViewer(email);
      return await createSetConfigurationTool({
        ...extra,
        resolveActorIdentity: async () => ({
          identity: { id: `identity:${user.id}` } as Identity,
          user,
        }),
        conversationId,
      }).execute?.(input, {});
    };
    const read = async (app: Hono<JuniorApiEnv>) =>
      spaceConfigurationSchema.parse(
        await (await send(app, "GET", `/${space.id}/configuration`)).json(),
      ).entries;

    expect(await read(bo)).toEqual([]);
    await expect(
      setting("spaces-config-bo@example.com", inSpace, {
        key: "github.repo",
        value: "a/b",
      }),
    ).rejects.toThrow("not a member of Configured");
    await expect(
      setting("spaces-config-ana@example.com", inSpace, {
        key: "github.token",
        value: "a",
      }),
    ).rejects.toThrow("secret-related");
    // A Conversation with no Slack channel and no Space has nothing to set.
    await expect(
      setting("spaces-config-ana@example.com", outside, {
        key: "github.repo",
        value: "a/b",
      }),
    ).rejects.toThrow("no Slack channel or Space");

    // A Thread changes the Space of its root.
    expect(
      await setting("spaces-config-ana@example.com", thread, {
        key: "github.repo",
        value: "getsentry/junior",
      }),
    ).toMatchObject({
      space: {
        id: space.id,
        name: "Configured",
        entries: [{ key: "github.repo", value: "getsentry/junior" }],
      },
    });
    // Anyone who reads the Space reads its configuration.
    expect(await read(bo)).toMatchObject([
      { key: "github.repo", value: "getsentry/junior" },
    ]);

    // A Conversation in the Space resolves the Space's value over the
    // values below it, and keeps the keys that the Space does not set.
    expect(
      await resolveConversationConfiguration({
        configuration: { "github.repo": "a/run", "sentry.org": "run-org" },
        conversationId: inSpace,
      }),
    ).toMatchObject({
      "github.repo": "getsentry/junior",
      "sentry.org": "run-org",
    });
    expect(
      await resolveConversationConfiguration({ conversationId: thread }),
    ).toMatchObject({ "github.repo": "getsentry/junior" });

    expect(
      await setting("spaces-config-ana@example.com", inSpace, {
        key: "github.repo",
        value: null,
      }),
    ).toMatchObject({ space: { entries: [] } });
    expect(await read(bo)).toEqual([]);

    // A move earlier in the Turn changes the Space that the tool writes.
    const anaUser = await signedInViewer("spaces-config-ana@example.com");
    const setInTurn = createSetConfigurationTool({
      conversationId: outside,
      resolveActorIdentity: async () => ({
        identity: { id: `identity:${anaUser.id}` } as Identity,
        user: anaUser,
      }),
    });
    expect((await moveTo(ana, outside, space.id)).status).toBe(200);
    expect(
      await setInTurn.execute?.({ key: "github.repo", value: "a/moved" }, {}),
    ).toMatchObject({
      space: {
        id: space.id,
        entries: [{ key: "github.repo", value: "a/moved" }],
      },
    });
    await setInTurn.execute?.({ key: "github.repo", value: null }, {});
    expect((await moveTo(ana, outside, null)).status).toBe(200);

    // In a Slack channel and a Space, one change sets both, and a later
    // tool in the Turn reads the new value. A read prefers the Space's.
    const channel = createLocationConfigurationService(memoryStorage());
    const configuration: Record<string, unknown> = {};
    expect(
      await setting(
        "spaces-config-ana@example.com",
        inSpace,
        { key: "sentry.org", value: "getsentry" },
        { configuration, locationConfiguration: channel },
      ),
    ).toMatchObject({
      channel: { entries: [{ key: "sentry.org", value: "getsentry" }] },
      space: { entries: [{ key: "sentry.org", value: "getsentry" }] },
    });
    expect(configuration).toEqual({ "sentry.org": "getsentry" });
    // Removing it brings back the install default for the rest of the Turn.
    const previousDefaults = getConfigDefaults();
    setConfigDefaults({ "sentry.org": "install-org" });
    try {
      await setting(
        "spaces-config-ana@example.com",
        inSpace,
        { key: "sentry.org", value: null },
        { configuration, locationConfiguration: channel },
      );
    } finally {
      setConfigDefaults(previousDefaults);
    }
    expect(configuration).toEqual({ "sentry.org": "install-org" });
    await setting(
      "spaces-config-ana@example.com",
      inSpace,
      { key: "sentry.org", value: "getsentry" },
      { configuration, locationConfiguration: channel },
    );
    await channel.set({ key: "sentry.org", value: "channel-org" });
    const read_ = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config get sentry.org",
      { conversationId: inSpace, locationConfiguration: channel },
    );
    expect(read_.handled && JSON.parse(read_.result.stdout)).toMatchObject({
      scope: "space",
      value: "getsentry",
    });
    // Outside a Space, it sets only the channel. A non-member never writes
    // the channel either, because every check runs before any write.
    expect(
      await setting(
        "spaces-config-bo@example.com",
        outside,
        { key: "sentry.project", value: "junior" },
        { locationConfiguration: channel },
      ),
    ).not.toHaveProperty("space");
    // A key that no plugin reads still saves, with a warning.
    expect(
      await setting(
        "spaces-config-bo@example.com",
        outside,
        { key: "made.up", value: "x" },
        { locationConfiguration: channel },
      ),
    ).toMatchObject({
      warning: expect.stringContaining('No installed plugin reads "made.up"'),
    });
    await expect(
      setting(
        "spaces-config-bo@example.com",
        inSpace,
        { key: "sentry.project", value: "other" },
        { locationConfiguration: channel },
      ),
    ).rejects.toThrow("not a member of Configured");
    expect(await channel.get("sentry.project")).toMatchObject({
      value: "junior",
    });
  });
});
