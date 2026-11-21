import { githubPlugin } from "@sentry/junior-github";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { createApp, defineJuniorPlugins } from "@/app";
import { conversationWatchesReportSchema } from "@/api/schema";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import {
  createTimerWatch,
  createWatch,
  takeDueTimerWatches,
} from "@/chat/events/store";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants } from "@/db/schema";
import {
  parentConversationId,
  prepareParentConversation,
  prepareSlackParentConversation,
  slackInvocationInput,
  slackParentConversationId,
} from "../../../fixtures/agent-invocations";

const NOW_MS = Date.now();

async function requestWatches(conversationId: string) {
  return await createJuniorApi().request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/watches`,
  );
}

async function viewerApi(email: string) {
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

async function listWatchIds(app: Hono<JuniorApiEnv>, conversationId: string) {
  const response = await app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/watches`,
  );
  expect(response.status).toBe(200);
  return conversationWatchesReportSchema
    .parse(await response.json())
    .watches.map((watch) => watch.id);
}

function cancel(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  watchId: string,
) {
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/watches/${encodeURIComponent(watchId)}`,
    { method: "DELETE" },
  );
}

describe("conversation watches API", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("returns the watches of the Conversation and of its child agents", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await prepareSlackParentConversation();
    const reviewer = await createAgentInvocation(
      {
        ...slackInvocationInput,
        agentName: "reviewer",
        idempotencyKey: "watches-reviewer",
      },
      NOW_MS,
    );
    await createWatch(
      {
        conversationId: slackParentConversationId,
        events: ["pull_request.checks.failed"],
        expiresAtMs: NOW_MS + 3_600_000,
        identifier: "getsentry/junior#1",
        intent: "Fix failing checks.",
        label: "getsentry/junior#1",
        match: { branch: "main" },
        namespace: "github",
        resourceType: "pull_request",
      },
      { nowMs: NOW_MS },
    );
    await createWatch(
      {
        conversationId: reviewer.childConversationId,
        events: ["pull_request.review_comment.created"],
        expiresAtMs: NOW_MS + 7_200_000,
        identifier: "getsentry/junior#2",
        intent: "Reply to review comments.",
        label: "getsentry/junior#2",
        namespace: "github",
        resourceType: "pull_request",
      },
      { nowMs: NOW_MS + 1_000 },
    );

    const response = await requestWatches(slackParentConversationId);

    expect(response.status).toBe(200);
    expect(
      conversationWatchesReportSchema.parse(await response.json()),
    ).toMatchObject({
      conversationId: slackParentConversationId,
      watches: [
        {
          events: ["pull_request.checks.failed"],
          expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
          intent: "Fix failing checks.",
          label: "getsentry/junior#1",
          match: { branch: "main" },
          namespace: "github",
          resourceType: "pull_request",
          url: "https://github.com/getsentry/junior/pull/1",
        },
        {
          childAgent: {
            conversationId: reviewer.childConversationId,
            name: "reviewer",
          },
          intent: "Reply to review comments.",
          label: "getsentry/junior#2",
        },
      ],
    });
  });

  it("redacts watch content from viewers without private access", async () => {
    await prepareParentConversation();
    await createWatch(
      {
        conversationId: parentConversationId,
        events: ["message.posted"],
        expiresAtMs: NOW_MS + 3_600_000,
        identifier: "C123",
        intent: "Answer follow-up questions.",
        label: "#private-channel",
        namespace: "slack",
        resourceType: "channel",
      },
      { nowMs: NOW_MS },
    );

    const response = await requestWatches(parentConversationId);

    expect(response.status).toBe(200);
    const report = conversationWatchesReportSchema.parse(await response.json());
    expect(report.watches).toHaveLength(1);
    expect(report.watches[0]).toMatchObject({
      events: ["message.posted"],
      namespace: "slack",
      redacted: true,
      resourceType: "channel",
    });
    expect(report.watches[0]).not.toHaveProperty("label");
    expect(report.watches[0]).not.toHaveProperty("intent");
    expect(report.watches[0]).not.toHaveProperty("url");
  });

  it("lets participants cancel a timer or an event Watch", async () => {
    const conversationId = "local:test:watches-cancel";
    const otherConversationId = "local:test:watches-other";
    for (const id of [conversationId, otherConversationId]) {
      await getConversationStore().recordActivity({
        conversationId: id,
        destination: { platform: "local", conversationId: id },
        nowMs: NOW_MS,
        source: "internal",
        visibility: "private",
      });
    }
    const owner = await viewerApi("watcher@example.com");
    const outsider = await viewerApi("outsider@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(NOW_MS),
        rootConversationId: conversationId,
        userId: owner.viewer.id,
      });
    const timer = await createTimerWatch({
      afterMs: 60_000,
      conversationId,
      intent: "Remind me to check the deploy.",
      toolCallId: "tool-call-timer",
    });
    const event = await createWatch(
      {
        conversationId,
        events: ["message.posted"],
        expiresAtMs: NOW_MS + 3_600_000,
        identifier: "C123",
        intent: "Answer follow-up questions.",
        label: "#support",
        namespace: "slack",
        resourceType: "channel",
      },
      // The timer reads the test clock, which restarts for each test, so
      // NOW_MS can be before or after it. Create the event Watch after it.
      { nowMs: timer.createdAtMs + 1_000 },
    );
    const other = await createWatch(
      {
        conversationId: otherConversationId,
        events: ["message.posted"],
        expiresAtMs: NOW_MS + 3_600_000,
        identifier: "C456",
        intent: "Answer follow-up questions.",
        label: "#other",
        namespace: "slack",
        resourceType: "channel",
      },
      { nowMs: NOW_MS },
    );

    const response = await owner.app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/watches`,
    );
    expect(
      conversationWatchesReportSchema.parse(await response.json()).watches,
    ).toMatchObject([
      {
        firesAt: new Date(timer.firesAtMs!).toISOString(),
        id: timer.id,
        intent: "Remind me to check the deploy.",
        resourceType: "timer",
      },
      { id: event.id, intent: "Answer follow-up questions." },
    ]);

    // A viewer who cannot read the private Conversation learns nothing.
    expect((await cancel(outsider.app, conversationId, timer.id)).status).toBe(
      404,
    );
    // A Watch of another Conversation cannot be cancelled through this one.
    expect((await cancel(owner.app, conversationId, other.id)).status).toBe(
      404,
    );
    expect(await listWatchIds(owner.app, conversationId)).toEqual([
      timer.id,
      event.id,
    ]);

    expect((await cancel(owner.app, conversationId, timer.id)).status).toBe(
      204,
    );
    expect((await cancel(owner.app, conversationId, event.id)).status).toBe(
      204,
    );
    expect(await listWatchIds(owner.app, conversationId)).toEqual([]);
    // The cancelled timer never fires.
    expect(
      (await takeDueTimerWatches(timer.firesAtMs! + 1_000)).map(
        (watch) => watch.id,
      ),
    ).not.toContain(timer.id);
  });

  it("rejects a cancel from a viewer who is not a participant", async () => {
    await prepareSlackParentConversation();
    const watch = await createWatch(
      {
        conversationId: slackParentConversationId,
        events: ["pull_request.merged"],
        expiresAtMs: NOW_MS + 3_600_000,
        identifier: "getsentry/junior#3",
        intent: "Report the merge.",
        label: "getsentry/junior#3",
        namespace: "github",
        resourceType: "pull_request",
      },
      { nowMs: NOW_MS },
    );
    const reader = await viewerApi("reader@example.com");

    const response = await cancel(
      reader.app,
      slackParentConversationId,
      watch.id,
    );

    expect(response.status).toBe(403);
    expect(await listWatchIds(reader.app, slackParentConversationId)).toEqual([
      watch.id,
    ]);
  });
});
