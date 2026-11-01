import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { takeReviewItem } from "@/chat/review-items/store";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { getConversation } from "@/chat/task-execution/store";
import { createAddReviewItemTool } from "@/chat/tools/review-items";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";

const REQUEST = {
  question: "Approve or reject this entry?",
  fields: [
    {
      id: "decision",
      kind: "choice",
      label: "Decision",
      options: [{ label: "Approve" }, { label: "Reject" }],
    },
    { id: "reason", kind: "text", label: "Reason" },
  ],
};

/** A person signed in to the dashboard, linked to Slack workspace T123. */
async function user(email: string): Promise<User> {
  const resolved = await resolveViewerUserFromSql(getDb(), email);
  if (!resolved) throw new Error(`no user for ${email}`);
  return {
    ...resolved,
    identities: [
      {
        id: `identity:slack:${email}`,
        provider: "slack",
        providerSubjectId: `U-${email}`,
        providerTenantId: "T123",
      },
    ],
  };
}

async function slackConversation(conversationId: string): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "CPUB" },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility: "public",
  });
}

async function addItem(input: Record<string, unknown>): Promise<string> {
  const tool = createAddReviewItemTool(
    {
      conversationId: "slack:CPUB:1.000001",
      resolveActorIdentity: async () => undefined,
      source: { kind: "scheduled_automation" },
    },
    createSlackReviewItemToolServices(createConversationWorkQueueTestAdapter),
  );
  const result = await (tool as any).execute(input, {});
  return result.item.id;
}

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return {
    act: (id: string, body: unknown) =>
      app.request(`http://localhost/api/review-items/${id}/actions`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    get: (path: string) =>
      app.request(`http://localhost/api/review-items${path}`),
  };
}

async function pendingTexts(conversationId: string): Promise<string[]> {
  const conversation = await getConversation({ conversationId });
  return (conversation?.execution.pendingMessages ?? []).map(
    (message) => message.input.text,
  );
}

describe("review item actions API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("closes an action item for every assignee on the first submit", async () => {
    const fixture = await createConversationFixture();
    await slackConversation("slack:CPUB:1.000001");
    await slackConversation("slack:CPUB:1.000002");
    await slackConversation("slack:CPUB:1.000003");
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    const cal = await user("cal@example.com");
    const id = await addItem({
      kind: "action",
      title: "Review acme entry",
      body: "The acme entry changed its license.",
      assignees: ["ana@example.com", "ben@example.com"],
      conversation_ids: ["slack:CPUB:1.000002"],
      dedupe_key: "fair-source:entry:acme",
      request: REQUEST,
    });
    // A notice does not need Ana, so it does not count.
    await addItem({
      kind: "notice",
      title: "Weekly report is ready",
      body: "Read it when you have time.",
      assignees: ["ana@example.com"],
      conversation_ids: ["slack:CPUB:1.000003"],
      dedupe_key: "report:weekly",
    });

    const anaCount = await (await api(fixture, ana).get("/count")).json();
    expect(anaCount).toEqual({ needsViewer: 1 });
    // The Conversations of the action item wait on Ana, but not on Cal.
    expect(
      await (await api(fixture, ana).get("/waiting-conversations")).json(),
    ).toEqual({
      conversationIds: ["slack:CPUB:1.000001", "slack:CPUB:1.000002"],
    });
    expect(
      await (await api(fixture, cal).get("/waiting-conversations")).json(),
    ).toEqual({ conversationIds: [] });
    const calList = await (await api(fixture, cal).get("")).json();
    expect(calList.items).toMatchObject([
      { kind: "notice" },
      { id, canAct: false },
    ]);
    // A person outside the Slack workspace does not see the public item.
    const outsider = { ...cal, identities: [] };
    expect((await (await api(fixture, outsider).get("")).json()).items).toEqual(
      [],
    );
    expect(
      (await api(fixture, cal).act(id, { action: "complete" })).status,
    ).toBe(403);
    expect(
      (await api(fixture, ana).act(id, { action: "complete" })).status,
    ).toBe(400);

    const submitted = await api(fixture, ana).act(id, {
      action: "submit",
      answer: { values: { decision: ["Reject"], reason: ["Not fair source"] } },
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      status: "done",
      canAct: false,
      closedBy: { email: "ana@example.com" },
      answer: { values: { decision: ["Reject"], reason: ["Not fair source"] } },
    });

    // Both linked Conversations hear from Ana, once, even after a retry.
    const retry = await api(fixture, ana).act(id, {
      action: "submit",
      answer: { values: { decision: ["Reject"] } },
    });
    expect(retry.status).toBe(200);
    for (const conversationId of [
      "slack:CPUB:1.000001",
      "slack:CPUB:1.000002",
    ]) {
      const texts = await pendingTexts(conversationId);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("ana@example.com answered review item");
      expect(texts[0]).toContain("Not fair source");
    }

    // Ben is too late, and the item leaves the open views.
    expect(
      (await api(fixture, ben).act(id, { action: "dismiss" })).status,
    ).toBe(409);
    expect(await (await api(fixture, ben).get("/count")).json()).toEqual({
      needsViewer: 0,
    });
    expect(
      await (await api(fixture, ben).get("/waiting-conversations")).json(),
    ).toEqual({ conversationIds: [] });
    // The list still shows every open item that Ben can see.
    expect(
      (await (await api(fixture, ben).get("")).json()).items,
    ).toMatchObject([{ kind: "notice" }]);
    // A search still finds the closed item.
    const found = await (await api(fixture, ben).get("?q=acme")).json();
    expect(found.items).toMatchObject([{ id, status: "done" }]);
  });

  it("lets anyone take an item assigned to Everyone", async () => {
    const fixture = await createConversationFixture();
    await slackConversation("slack:CPUB:1.000001");
    const cal = await user("cal@example.com");
    const id = await addItem({
      kind: "action",
      title: "Pull request needs review",
      body: "It waits on a reviewer.",
      assignees: ["everyone"],
      dedupe_key: "pr:7",
      request: REQUEST,
    });

    const list = await (await api(fixture, cal).get("")).json();
    expect(list.items).toMatchObject([{ id, canAct: true, canTake: true }]);
    // An item for Everyone needs no one until a person takes it.
    expect(await (await api(fixture, cal).get("/count")).json()).toEqual({
      needsViewer: 0,
    });
    expect(
      await (await api(fixture, cal).get("/waiting-conversations")).json(),
    ).toEqual({ conversationIds: [] });

    // The take committed, but its messages did not go out. A retry of the
    // take sends them.
    await takeReviewItem(getDb(), { id, nowMs: Date.now(), userId: cal.id });
    await api(fixture, cal).act(id, { action: "take" });
    const taken = await api(fixture, cal).act(id, { action: "take" });
    expect(await taken.json()).toMatchObject({
      assignedToEveryone: false,
      assignees: [{ email: "cal@example.com" }],
      canTake: false,
      status: "open",
    });
    expect(await (await api(fixture, cal).get("/count")).json()).toEqual({
      needsViewer: 1,
    });
    expect(
      await (await api(fixture, cal).get("/waiting-conversations")).json(),
    ).toEqual({ conversationIds: ["slack:CPUB:1.000001"] });
    const texts = await pendingTexts("slack:CPUB:1.000001");
    expect(texts).toEqual([
      expect.stringContaining("cal@example.com took review item"),
    ]);
  });
});
