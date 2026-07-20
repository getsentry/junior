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

  it("indexes only the latest safe turn-session summary", async () => {
    const { listAgentTurnSessionSummaries, upsertAgentTurnSessionRecord } =
      await import("@/chat/state/turn-session");
    const conversationId = "slack:C-reporting-support:summary-index";

    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId: "reporting-support-turn",
      sliceId: 1,
      state: "running",
      piMessages: [],
    });
    await upsertAgentTurnSessionRecord({
      modelId: "test/model",
      conversationId,
      sessionId: "reporting-support-turn",
      sliceId: 2,
      state: "completed",
      piMessages: [],
      cumulativeDurationMs: 1_200,
      errorMessage: "provider failed with sensitive details",
      loadedSkillNames: ["triage"],
    });

    const matching = (await listAgentTurnSessionSummaries()).filter(
      (summary) => summary.sessionId === "reporting-support-turn",
    );

    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      conversationId,
      sessionId: "reporting-support-turn",
      sliceId: 2,
      state: "completed",
      cumulativeDurationMs: 1_200,
      loadedSkillNames: ["triage"],
    });
    expect(matching[0]).not.toHaveProperty("errorMessage");
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
        teamId: "T-reporting-support",
        channelId: "C-reporting-support",
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
      await import("@/chat/state/turn-session");
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
      channelId: "C-reporting-support-private",
      channelName: "reporting-support-stealth-project",
      title: "Reporting support stealth planning",
      visibility: "private" as const,
    },
    {
      name: "a C-prefixed conversation without confirmed public visibility",
      conversationId: "slack:C-reporting-support:unknown",
      channelId: "C-reporting-support-unknown",
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
              teamId: "T-reporting-support",
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
