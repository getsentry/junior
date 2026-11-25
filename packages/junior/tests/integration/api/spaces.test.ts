import type { Identity } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  conversationDetailReportSchema,
  conversationFeedSchema,
  setConversationSpaceResponseSchema,
  spaceListSchema,
  spaceConfigurationSchema,
  spaceMemberListSchema,
  spaceSchema,
  versionsSchema,
} from "@/api/schema";
import { canReadConversation } from "@/api/conversations/access";
import { resolveConversationConfiguration } from "@/chat/configuration/conversation";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { getConversationStore, getDb } from "@/chat/db";
import { createSetSpaceConfigurationTool } from "@/chat/tools/set-space-configuration";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { closeConversationFixture } from "../../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../../fixtures/conversation-work";
import { signedInViewer } from "../../fixtures/user";

const queue = createConversationWorkQueueTestAdapter();

function apiFor(email?: string): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    if (email) context.set("viewer", await signedInViewer(email));
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: queue }));
  return app;
}

async function request(
  app: Hono<JuniorApiEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(`http://localhost/api${path}`, {
    method,
    ...(body === undefined
      ? undefined
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

async function send(
  app: Hono<JuniorApiEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await request(app, method, `/spaces${path}`, body);
}

async function createSpace(app: Hono<JuniorApiEnv>, name: string) {
  return spaceSchema.parse(
    await (await send(app, "POST", "", { name })).json(),
  );
}

async function startConversation(
  app: Hono<JuniorApiEnv>,
  key: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(app, "POST", "/conversations", {
    idempotencyKey: key,
    message: `Work for ${key}`,
    title: key,
    ...extra,
  });
  expect(response.status).toBe(200);
  return acceptedConversationMessageSchema.parse(await response.json())
    .conversationId;
}

async function spaceFeed(
  app: Hono<JuniorApiEnv>,
  spaceId: string,
  status = "active",
) {
  const response = await request(
    app,
    "GET",
    `/conversations?spaceId=${spaceId}&status=${status}`,
  );
  expect(response.status).toBe(200);
  return conversationFeedSchema.parse(await response.json()).conversations;
}

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

async function startThread(parentConversationId: string, id: string) {
  await getConversationStore().createChild({
    childConversationId: id,
    kind: "thread",
    parentConversationId,
  });
  return id;
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

    const joined = await send(bo, "PUT", `/${space.id}/members/me`);
    expect(joined.status).toBe(200);
    expect(spaceSchema.parse(await joined.json())).toMatchObject({
      memberCount: 2,
      viewerIsMember: true,
    });
    // Joining again changes nothing.
    await send(bo, "PUT", `/${space.id}/members/me`);
    const members = spaceMemberListSchema.parse(
      await (await send(ana, "GET", `/${space.id}/members`)).json(),
    );
    expect(members.members.map((member) => member.email)).toEqual([
      "spaces-api-ana@example.com",
      "spaces-api-bo@example.com",
    ]);

    const left = await send(bo, "DELETE", `/${space.id}/members/me`);
    expect(spaceSchema.parse(await left.json())).toMatchObject({
      memberCount: 1,
      viewerIsMember: false,
    });
    expect(await listNames(bo)).not.toContain("Billing migration");
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

    const archived = spaceSchema.parse(
      await (
        await send(ana, "PATCH", `/${space.id}/archive`, { archived: true })
      ).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(await listNames(ana)).not.toContain("Junior for iOS");
    expect(await listNames(ana, "?archived=true")).toContain("Junior for iOS");
    // When every member leaves an archived Space, anyone can still join and
    // restore it.
    await send(ana, "DELETE", `/${space.id}/members/me`);
    expect((await send(bo, "PUT", `/${space.id}/members/me`)).status).toBe(200);
    const restored = spaceSchema.parse(
      await (
        await send(bo, "PATCH", `/${space.id}/archive`, { archived: false })
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
    await send(ana, "DELETE", `/${other.id}/members/me`);
    expect((await moveTo(ana, oneOff, other.id)).status).toBe(403);
    expect(
      setConversationSpaceResponseSchema.parse(
        await (await moveTo(ana, oneOff, null)).json(),
      ),
    ).toEqual({ space: null });
    expect(
      (await spaceFeed(ana, space.id)).map((row) => row.conversationId),
    ).toEqual([inSpace]);
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
    expect((await send(bo, "PUT", `/${space.id}/members/me`)).status).toBe(404);

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

    // A member adds people, and every member reads every Conversation.
    expect(
      (
        await send(bo, "POST", `/${space.id}/members`, {
          email: "spaces-private-bo@example.com",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(ana, "POST", `/${space.id}/members`, {
          email: "nobody@example.com",
        })
      ).status,
    ).toBe(404);
    const added = await send(ana, "POST", `/${space.id}/members`, {
      email: "spaces-private-bo@example.com",
    });
    expect(spaceSchema.parse(await added.json()).memberCount).toBe(2);
    expect(await detail(bo, inSpace)).toMatchObject({
      space: spaceRef,
      visibility: "private",
    });
    expect(
      (await spaceFeed(bo, space.id)).map((row) => row.conversationId),
    ).toEqual([inSpace]);

    // A Conversation keeps its visibility, so it can't join a private Space.
    expect((await moveTo(ana, oneOff, space.id)).status).toBe(409);

    // Data stays in the Space: Conversations in it read each other, and a
    // Conversation outside it reads none of them.
    const sibling = await startConversation(ana, "payroll-sibling", {
      spaceId: space.id,
    });
    expect(await canReadConversation(getDb(), sibling, inSpace)).toBe(true);
    const outside = await startConversation(ana, "payroll-outside");
    expect(await canReadConversation(getDb(), outside, inSpace)).toBe(false);
    expect(await canReadConversation(getDb(), inSpace, outside)).toBe(true);
    expect((await moveTo(ana, sibling, null)).status).toBe(409);

    // A Space keeps the visibility it was created with.
    expect(
      (await send(ana, "PATCH", `/${space.id}`, { visibility: "public" }))
        .status,
    ).toBe(400);
    expect(await detailSpace(cy, inSpace)).toBeNull();

    // A participant who leaves no longer finds its Conversations.
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1_000),
        rootConversationId: inSpace,
        userId: (await signedInViewer("spaces-private-bo@example.com")).id,
      });
    const inbox = async () =>
      conversationFeedSchema
        .parse(await (await request(bo, "GET", "/conversations")).json())
        .conversations.map((row) => row.conversationId);
    expect(await inbox()).toContain(inSpace);
    expect((await send(bo, "DELETE", `/${space.id}/members/me`)).status).toBe(
      200,
    );
    expect(await inbox()).not.toContain(inSpace);

    // The last member stays, so somebody can always read it, even when the
    // last two leave at once.
    await send(ana, "POST", `/${space.id}/members`, {
      email: "spaces-private-bo@example.com",
    });
    const leaves = await Promise.all(
      [ana, bo].map((app) => send(app, "DELETE", `/${space.id}/members/me`)),
    );
    expect(leaves.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
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
    ) => {
      const user = await signedInViewer(email);
      return await createSetSpaceConfigurationTool({
        conversationId,
        resolveActorIdentity: async () => ({
          identity: { id: `identity:${user.id}` } as Identity,
          user,
        }),
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
    await expect(
      setting("spaces-config-ana@example.com", outside, {
        key: "github.repo",
        value: "a/b",
      }),
    ).rejects.toThrow("in no Space");

    // A Thread changes the Space of its root.
    expect(
      await setting("spaces-config-ana@example.com", thread, {
        key: "github.repo",
        value: "getsentry/junior",
      }),
    ).toMatchObject({
      space: { id: space.id, name: "Configured" },
      entries: [{ key: "github.repo", value: "getsentry/junior" }],
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
    // An older root with no root id resolves its Space's values too.
    await getDb()
      .update(juniorConversations)
      .set({ rootConversationId: null })
      .where(eq(juniorConversations.conversationId, inSpace));
    expect(
      await resolveConversationConfiguration({ conversationId: inSpace }),
    ).toMatchObject({ "github.repo": "getsentry/junior" });

    expect(
      await setting("spaces-config-ana@example.com", inSpace, {
        key: "github.repo",
        value: null,
      }),
    ).toMatchObject({ entries: [] });
    expect(await read(bo)).toEqual([]);
  });

  it("stops and archives every Conversation when a Space is archived", async () => {
    const ana = apiFor("spaces-archive-ana@example.com");
    const space = await createSpace(ana, "Short project");
    const first = await startConversation(ana, "short-first", {
      spaceId: space.id,
    });
    const second = await startConversation(ana, "short-second", {
      spaceId: space.id,
    });
    const outside = await startConversation(ana, "short-outside");
    const thread = await startThread(first, "local:spaces-archive-thread");
    // A root from before `root_conversation_id` was set is archived too.
    await getDb()
      .update(juniorConversations)
      .set({ rootConversationId: null })
      .where(eq(juniorConversations.conversationId, second));

    await send(ana, "PATCH", `/${space.id}/archive`, { archived: true });
    expect(await spaceFeed(ana, space.id)).toEqual([]);
    expect(
      (await spaceFeed(ana, space.id, "archived"))
        .map((row) => row.conversationId)
        .sort(),
    ).toEqual([first, second].sort());
    expect(await getConversationStoppedAtMs(first)).toBeDefined();
    expect(await getConversationStoppedAtMs(second)).toBeDefined();
    expect(await getConversationStoppedAtMs(outside)).toBeUndefined();
    expect(
      (await getConversationStore().get({ conversationId: thread }))
        ?.archivedAtMs,
    ).toBeDefined();
    // An archived Space takes no new work.
    expect(
      (
        await request(ana, "POST", "/conversations", {
          idempotencyKey: "short-late",
          message: "One more",
          spaceId: space.id,
        })
      ).status,
    ).toBe(409);

    // Restore brings back what the archive archived.
    await send(ana, "PATCH", `/${space.id}/archive`, { archived: false });
    expect(
      (await spaceFeed(ana, space.id)).map((row) => row.conversationId).sort(),
    ).toEqual([first, second].sort());
  });
});
