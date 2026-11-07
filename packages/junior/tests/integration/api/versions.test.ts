import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { CONVERSATION_VERSION_HEADER, versionsSchema } from "@/api/schema";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
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

    // A child agent writes only its own row. The tree token still moves.
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
    expect(changed(withChild, withInput)).toEqual([
      "conversation",
      "conversations",
    ]);

    // A pin writes no detail version, but the feed shows it.
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
    expect(changed(withInput, withPin)).toEqual(["conversations"]);

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
    expect(changed(closed, await read())).toContain("spend");
  });
});
