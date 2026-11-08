import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { CONVERSATION_VERSION_HEADER, versionsSchema } from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { closeReviewItem, insertReviewItem } from "@/chat/review-items/store";
import { appendInboundMessage } from "@/chat/task-execution/store";
import {
  appendVisibleHistory,
  createChild,
  recordRoot,
} from "../../fixtures/dashboard-reporting";

const OWN = "slack:CVERSIONS:own";
const OTHER = "slack:CVERSIONS:other";
const SLACK_ACTOR = {
  email: "ana@example.com",
  slackUserId: "UANA",
  teamId: "TREPORTING",
};

async function authenticatedApi() {
  const viewer = await resolveViewerUser(SLACK_ACTOR.email);
  if (!viewer) throw new Error("missing viewer");
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return { app, viewer };
}

/** Record a child agent Turn: an Event and its running execution. */
async function childAgentTurn(conversationId: string, atMs: number) {
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "tool_execution_started",
        toolCallId: `${conversationId}:tool-${atMs}`,
        toolName: "search",
      },
      createdAtMs: atMs,
    },
  ]);
  await getConversationStore().recordExecution({
    conversationId,
    createdAtMs: atMs,
    execution: {
      runId: `${conversationId}:run`,
      status: "running",
      updatedAtMs: atMs,
    },
    lastActivityAtMs: atMs,
    metrics: { durationMs: 50 },
    source: "slack",
    updatedAtMs: atMs,
  });
}

/** Name the tokens that differ between two reads. */
function changed(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
) {
  return Object.keys({ ...before, ...after })
    .filter((key) => before[key] !== after[key])
    .sort();
}

describe("versions API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("moves only the token whose read changed", async () => {
    const { app, viewer } = await authenticatedApi();
    await recordRoot(OWN, "private", SLACK_ACTOR);
    await recordRoot(OTHER, "private");
    const read = async (conversationId = OWN) =>
      versionsSchema.parse(
        await (
          await app.request(
            `http://localhost/api/versions?conversationId=${encodeURIComponent(conversationId)}`,
          )
        ).json(),
      );
    const detailVersion = async () =>
      (
        await app.request(`http://localhost/api/conversations/${OWN}`)
      ).headers.get(CONVERSATION_VERSION_HEADER);

    const first = await read();
    expect(await read()).toEqual(first);
    expect(await detailVersion()).toBe(first.conversation);
    // A Conversation that does not exist has no token.
    expect(
      (await read("slack:CVERSIONS:missing")).conversation,
    ).toBeUndefined();

    // Another person's Conversation is outside the viewer's feed.
    await appendVisibleHistory(OTHER);
    expect(await read()).toEqual(first);

    // Starting a child agent writes Events to the root, so the feed moves.
    await createChild({
      childConversationId: `${OWN}:child`,
      parentConversationId: OWN,
    });
    const withChild = await read();
    expect(changed(first, withChild)).toEqual([
      "conversation",
      "conversations",
    ]);
    expect(await detailVersion()).toBe(withChild.conversation);

    // A child agent's Turn writes only its own row. The feed row shows none
    // of it, so only the open Conversation's tree token moves.
    await childAgentTurn(`${OWN}:child`, 20);
    const withChildTurn = await read();
    expect(changed(withChild, withChildTurn)).toEqual(["conversation"]);
    expect(await detailVersion()).toBe(withChildTurn.conversation);

    // Input that waits in the mailbox of an idle Conversation is part of its
    // detail, so it moves the tree token.
    await appendInboundMessage({
      message: {
        conversationId: OWN,
        createdAtMs: 10,
        delivery: "defer",
        inboundMessageId: `${OWN}:input`,
        input: { text: "Any news?" },
        receivedAtMs: 10,
        source: "slack",
      },
      nowMs: 10,
    });
    const withInput = await read();
    expect(changed(withChildTurn, withInput)).toEqual([
      "conversation",
      "conversations",
    ]);

    // A pin writes no detail version, but the feed and the detail show it.
    const pinned = await app.request(
      `http://localhost/api/conversations/${OWN}/pin`,
      {
        body: JSON.stringify({ pinned: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(pinned.status).toBe(200);
    const withPin = await read();
    expect(changed(withInput, withPin)).toEqual([
      "conversation",
      "conversations",
    ]);
    expect(await detailVersion()).toBe(withPin.conversation);

    const item = await insertReviewItem(getDb(), {
      addedByConversationId: OWN,
      assignedToEveryone: false,
      assigneeUserIds: [viewer.id],
      body: "Approve the change.",
      conversationIds: [OWN],
      dedupeKey: "versions:approve",
      kind: "action",
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      request: {
        fields: [
          {
            id: "decision",
            kind: "choice",
            label: "Decision",
            options: [{ label: "Approve" }, { label: "Reject" }],
          },
        ],
        question: "Approve the change?",
      },
      title: "Approve",
      visibility: "private",
    });
    const withItem = await read();
    expect(changed(withPin, withItem)).toEqual(["reviewItems"]);
    await closeReviewItem(getDb(), {
      id: item!.id,
      nowMs: Date.parse("2026-10-01T12:01:00.000Z"),
      status: "done",
    });
    const closed = await read();
    expect(changed(withItem, closed)).toEqual(["reviewItems"]);

    // A recorded Turn changes the viewer's spend.
    const nowMs = Date.now();
    await getConversationStore().recordExecution({
      conversationId: OWN,
      createdAtMs: nowMs,
      execution: { runId: "turn-1", status: "idle", updatedAtMs: nowMs },
      lastActivityAtMs: nowMs,
      metrics: { durationMs: 100, usage: { cost: { total: 0.5 } } },
      source: "slack",
      updatedAtMs: nowMs,
    });
    const withTurn = await read();
    expect(changed(closed, withTurn)).toEqual([
      "conversation",
      "conversations",
      "spend",
    ]);

    // A reply changes the feed row but costs nothing, so spend stays.
    await appendVisibleHistory(OWN, "Root answer");
    await getConversationEventStore().append(OWN, [
      {
        data: {
          type: "tool_execution_started",
          toolCallId: `${OWN}:later-tool`,
          toolName: "search",
        },
        createdAtMs: nowMs + 1,
      },
    ]);
    expect(changed(withTurn, await read())).toEqual([
      "conversation",
      "conversations",
    ]);
  });
});
