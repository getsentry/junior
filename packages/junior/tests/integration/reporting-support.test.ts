import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error("DATABASE_URL is required for reporting integration tests");
}

describe("reporting support", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: TEST_DATABASE_URL,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    const { closeDb } = await import("@/chat/db");
    await closeDb();
    await disconnectStateAdapter();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("lists recent conversations through the conversation reporting API", async () => {
    const { getConversationStore } = await import("@/chat/db");
    const { readConversationFeed } = await import("@/api/conversations/list");
    const conversationId = "slack:C-reporting-support:plugin-feed";

    await getConversationStore().recordActivity({
      conversationId,
      channelName: "reporting-support-incidents",
      destination: {
        platform: "slack",
        teamId: "TREPORTSUPPORT",
        channelId: "CREPORTSUPPORT",
      },
      nowMs: Date.now(),
      source: "slack",
      title: "Reporting support incident",
      visibility: "public",
    });

    const summary = (await readConversationFeed()).conversations.find(
      (item) => item.conversationId === conversationId,
    );
    expect(summary).toMatchObject({
      channelName: "reporting-support-incidents",
      conversationId,
      displayTitle: expect.any(String),
      surface: "slack",
      status: "completed",
    });
  });

  it("mirrors local turn sessions into the SQL conversation store", async () => {
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/task-execution/turn-cursor");
    const { getConversationStore } = await import("@/chat/db");
    const conversationId = "local:reporting-support:run";

    await recordAgentTurnSessionSummary({
      conversationId,
      destination: { platform: "local", conversationId },
      sessionId: "reporting-support-local-turn",
      sliceId: 1,
      state: "completed",
      surface: "internal",
      ttlMs: 60_000,
    });

    await expect(
      getConversationStore().get({ conversationId }),
    ).resolves.toMatchObject({ conversationId, source: "local" });
  });

  it.each([
    {
      name: "a G-prefixed private conversation",
      conversationId: "slack:G-reporting-support:private",
      channelId: undefined,
      channelName: "reporting-support-private-room",
      title: "Reporting support sensitive escalation",
      visibility: undefined,
    },
    {
      name: "a source-confirmed private C-prefixed conversation",
      conversationId: "slack:C-reporting-support:confirmed-private",
      channelId: "CREPORTSUPPORTPRIV",
      channelName: "reporting-support-stealth-project",
      title: "Reporting support stealth planning",
      visibility: "private" as const,
    },
    {
      name: "a C-prefixed conversation without confirmed public visibility",
      conversationId: "slack:C-reporting-support:unknown",
      channelId: "CREPORTSUPPORTUNK",
      channelName: "reporting-support-maybe-private-room",
      title: "Reporting support private by default",
      visibility: undefined,
    },
  ])("redacts $name", async (testCase) => {
    const { getConversationStore } = await import("@/chat/db");
    const { readConversationFeed } = await import("@/api/conversations/list");

    await getConversationStore().recordActivity({
      conversationId: testCase.conversationId,
      channelName: testCase.channelName,
      ...(testCase.channelId
        ? {
            destination: {
              platform: "slack" as const,
              teamId: "TREPORTSUPPORT",
              channelId: testCase.channelId,
            },
          }
        : {}),
      nowMs: Date.now(),
      source: "slack",
      title: testCase.title,
      ...(testCase.visibility ? { visibility: testCase.visibility } : {}),
    });

    const summaries = (await readConversationFeed()).conversations;
    const serialized = JSON.stringify(summaries);
    const summary = summaries.find(
      (item) => item.conversationId === testCase.conversationId,
    );

    expect(serialized).not.toContain(testCase.channelName);
    expect(serialized).not.toContain(testCase.title);
    expect(summary).toMatchObject({
      conversationId: testCase.conversationId,
      channelName: "Private Conversation",
      channelNameRedacted: true,
      displayTitle: "Private Conversation",
    });
  });
});
