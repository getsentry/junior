import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationPlanItemSchema,
  conversationPlanReportSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { changePlan } from "@/chat/plan/store";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants } from "@/db/schema";

async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return { app, viewer };
}

async function readPlan(app: Hono<JuniorApiEnv>, conversationId: string) {
  const response = await app.request(
    `http://localhost/api/conversations/${conversationId}/plan`,
  );
  expect(response.status).toBe(200);
  return conversationPlanReportSchema.parse(await response.json()).items;
}

function setStatus(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  itemId: number,
  status: string,
) {
  return app.request(
    `http://localhost/api/conversations/${conversationId}/plan/${itemId}`,
    {
      body: JSON.stringify({ status }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

describe("conversation plan API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("shows the plan to participants and lets them close items", async () => {
    const conversationId = "local:test:plan";
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      nowMs: 1_000,
      source: "internal",
      visibility: "private",
    });
    const owner = await authenticatedApi("planner@example.com");
    const outsider = await authenticatedApi("outsider@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1_000),
        rootConversationId: conversationId,
        userId: owner.viewer.id,
      });
    const self = { conversationId };
    const {
      items: [draft, approve],
    } = await changePlan(getSqlExecutor(), {
      conversationId,
      nowMs: 1_000,
      change: {
        add: [
          {
            title: "Draft the brief",
            notes: "Use the release notes.",
            status: "in_progress",
            assignee: self,
          },
          {
            title: "Approve the brief",
            status: "pending",
            assignee: { userId: owner.viewer.id },
          },
        ],
        update: [],
        remove: [],
      },
    });

    // Titles and notes are conversation content.
    expect(await readPlan(outsider.app, conversationId)).toEqual([
      {
        id: draft!.id,
        status: "in_progress",
        assignee: { kind: "self" },
        redacted: true,
        updatedAt: new Date(1_000).toISOString(),
      },
      {
        id: approve!.id,
        status: "pending",
        assignee: { kind: "user" },
        redacted: true,
        updatedAt: new Date(1_000).toISOString(),
      },
    ]);
    expect(
      (await setStatus(outsider.app, conversationId, approve!.id, "done"))
        .status,
    ).toBe(404);
    // Only the agent can start work.
    expect(
      (await setStatus(owner.app, conversationId, approve!.id, "in_progress"))
        .status,
    ).toBe(400);

    const response = await setStatus(
      owner.app,
      conversationId,
      approve!.id,
      "done",
    );
    expect(response.status).toBe(200);
    expect(conversationPlanItemSchema.parse(await response.json())).toEqual(
      expect.objectContaining({
        status: "done",
        changedBy: "planner@example.com",
      }),
    );
    expect(
      (await setStatus(owner.app, conversationId, 999_999, "done")).status,
    ).toBe(404);

    // Open items come first, then recently closed ones.
    expect(await readPlan(owner.app, conversationId)).toEqual([
      expect.objectContaining({
        title: "Draft the brief",
        notes: "Use the release notes.",
        status: "in_progress",
      }),
      expect.objectContaining({
        title: "Approve the brief",
        status: "done",
        assignee: { kind: "user", name: "planner@example.com" },
      }),
    ]);
  });
});
