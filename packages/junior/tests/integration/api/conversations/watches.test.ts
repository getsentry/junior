import { githubPlugin } from "@sentry/junior-github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { conversationWatchesReportSchema } from "@/api/schema";
import { createAgentInvocation } from "@/chat/agent-invocations/store";
import { closeDb } from "@/chat/db";
import { createWatch } from "@/chat/events/store";
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
});
