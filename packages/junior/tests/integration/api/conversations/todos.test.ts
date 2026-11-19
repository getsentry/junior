import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { CONVERSATION_VERSION_HEADER } from "@/api/schema";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationTodoSchema,
  conversationTodosReportSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { changeTodos } from "@/chat/todos/store";
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

async function readTodos(app: Hono<JuniorApiEnv>, conversationId: string) {
  const response = await app.request(
    `http://localhost/api/conversations/${conversationId}/todos`,
  );
  expect(response.status).toBe(200);
  return conversationTodosReportSchema.parse(await response.json()).todos;
}

async function detailVersion(app: Hono<JuniorApiEnv>, conversationId: string) {
  return (
    await app.request(`http://localhost/api/conversations/${conversationId}`)
  ).headers.get(CONVERSATION_VERSION_HEADER);
}

function setStatus(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  todoId: number,
  status: string,
) {
  return app.request(
    `http://localhost/api/conversations/${conversationId}/todos/${todoId}`,
    {
      body: JSON.stringify({ status }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

describe("conversation To-dos API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("shows To-dos to participants and lets them close and reopen them", async () => {
    const conversationId = "local:test:todos";
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      nowMs: 1_000,
      source: "internal",
      visibility: "private",
    });
    const owner = await authenticatedApi("owner@example.com");
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
      todos: [draft, approve],
    } = await changeTodos(getSqlExecutor(), {
      conversationId,
      nowMs: 1_000,
      change: {
        add: [
          {
            title: "Draft the brief",
            notes: "Use the release notes.",
            status: "open",
            assignee: self,
          },
          {
            title: "Approve the brief",
            status: "open",
            assignee: { userId: owner.viewer.id },
          },
        ],
        update: [],
        remove: [],
      },
    });

    // Titles and notes are conversation content.
    expect(await readTodos(outsider.app, conversationId)).toEqual([
      {
        id: draft!.id,
        status: "open",
        assignee: { kind: "self" },
        redacted: true,
        updatedAt: new Date(1_000).toISOString(),
      },
      {
        id: approve!.id,
        status: "open",
        assignee: { kind: "user" },
        redacted: true,
        updatedAt: new Date(1_000).toISOString(),
      },
    ]);
    expect(
      (await setStatus(outsider.app, conversationId, approve!.id, "done"))
        .status,
    ).toBe(404);
    // Only open, done, and dropped are statuses.
    expect(
      (await setStatus(owner.app, conversationId, approve!.id, "pending"))
        .status,
    ).toBe(400);

    const beforeChange = await detailVersion(owner.app, conversationId);
    const response = await setStatus(
      owner.app,
      conversationId,
      approve!.id,
      "done",
    );
    expect(response.status).toBe(200);
    // Open detail views reload the To-dos when the detail version moves.
    expect(await detailVersion(owner.app, conversationId)).not.toBe(
      beforeChange,
    );
    expect(conversationTodoSchema.parse(await response.json())).toEqual(
      expect.objectContaining({
        status: "done",
        changedBy: "owner@example.com",
      }),
    );
    expect(
      (await setStatus(owner.app, conversationId, 999_999, "done")).status,
    ).toBe(404);

    // A person can drop a To-do and open it again.
    expect(
      (await setStatus(owner.app, conversationId, draft!.id, "dropped")).status,
    ).toBe(200);
    expect(
      (await setStatus(owner.app, conversationId, draft!.id, "open")).status,
    ).toBe(200);

    // Open To-dos come first, then recently closed ones.
    expect(await readTodos(owner.app, conversationId)).toEqual([
      expect.objectContaining({
        title: "Draft the brief",
        notes: "Use the release notes.",
        status: "open",
      }),
      expect.objectContaining({
        title: "Approve the brief",
        status: "done",
        assignee: { kind: "user", name: "owner@example.com" },
      }),
    ]);
  });
});
