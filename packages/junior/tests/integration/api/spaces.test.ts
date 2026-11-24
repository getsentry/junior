import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  spaceListSchema,
  spaceMemberListSchema,
  spaceSchema,
} from "@/api/schema";
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

async function send(
  app: Hono<JuniorApiEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(`http://localhost/api/spaces${path}`, {
    method,
    ...(body === undefined
      ? undefined
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
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
});
