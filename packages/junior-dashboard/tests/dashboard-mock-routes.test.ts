import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationSubagentTranscriptReport as DashboardConversationSubagentTranscript,
  JuniorReporting,
} from "@sentry/junior/reporting";
import { createDashboardApp } from "../src/app";
import {
  createMockConversationReporting,
  DASHBOARD_QA_CONVERSATION_ID,
} from "../src/mock-conversations";

function reporting(): JuniorReporting {
  return {
    async getHealth() {
      return {
        status: "ok",
        service: "junior",
        timestamp: "2026-05-29T00:00:00.000Z",
      };
    },
    async getRuntimeInfo() {
      return {
        cwd: "/workspace",
        homeDir: "/workspace/app",
        descriptionText: "Dashboard mock route test",
        providers: ["github"],
        skills: [{ name: "triage", pluginProvider: "github" }],
        packagedContent: {
          packageNames: ["@sentry/junior-github"],
          packages: [],
          manifestRoots: [],
          skillRoots: [],
          tracingIncludes: [],
        },
      };
    },
    async getPlugins() {
      return [{ name: "github" }];
    },
    async getSkills() {
      return [{ name: "triage", pluginProvider: "github" }];
    },
    async listConversations() {
      return {
        source: "conversation_index",
        generatedAt: "2026-05-29T00:00:00.000Z",
        conversations: [
          {
            conversationId: "slack:C1:123",
            cumulativeDurationMs: 0,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            displayTitle: "Conversation",
            channel: "C1",
          },
        ],
      };
    },
    async getConversationStats() {
      return {
        active: 1,
        conversations: 1,
        durationMs: 0,
        failed: 0,
        generatedAt: "2026-05-29T00:00:00.000Z",
        hung: 0,
        locations: [],
        requesters: [],
        sampleLimit: 1,
        sampleSize: 1,
        source: "conversation_index",
        truncated: false,
        runs: 1,
        windowEnd: "2026-05-29T00:00:00.000Z",
        windowStart: "2026-05-22T00:00:00.000Z",
      };
    },
    async listRecentConversations() {
      return [];
    },
    async getPluginOperationalReports() {
      return {
        source: "plugins",
        generatedAt: "2026-05-29T00:00:00.000Z",
        reports: [],
      };
    },
    async getConversation(conversationId: string) {
      return {
        conversationId,
        displayTitle: "Conversation",
        generatedAt: "2026-05-29T00:00:00.000Z",
        runs: [
          {
            conversationId,
            cumulativeDurationMs: 0,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            displayTitle: "Conversation",
            channel: "C1",
            transcriptAvailable: true,
            transcript: [],
          },
        ],
      };
    },
    async getConversationSubagentTranscript(
      _conversationId,
      _runId,
      subagentId,
    ) {
      return {
        type: "subagent",
        createdAt: "2026-05-29T00:00:00.000Z",
        id: subagentId,
        status: "error",
        subagentKind: "unknown",
        transcript: [],
        transcriptAvailable: false,
        unavailableReason: "not_found",
      };
    },
  };
}

describe("dashboard mock conversation routes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("overlays mock conversations for local dashboard visual QA", async () => {
    // Pin time to match the hardcoded conversation dates in the mock reporting fixture.
    // Without this, recentConversationGroups filters out conversations older than 7 days.
    vi.useFakeTimers({ now: new Date("2026-05-30T00:00:00.000Z") });
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
      reporting: reporting(),
    });

    const conversations = await app.fetch(
      new Request("http://localhost/api/conversations"),
    );
    expect(conversations.status).toBe(200);
    const conversationBody = (await conversations.json()) as {
      conversations: Array<{
        activity?: unknown;
        conversationId: string;
        cumulativeDurationMs: number;
        id: string;
      }>;
    };
    expect(conversationBody.conversations[0]?.conversationId).toBe(
      "slack:CQA123:1770003600.000200",
    );
    expect(
      conversationBody.conversations.map(
        (conversation) => conversation.conversationId,
      ),
    ).toContain("slack:C1:123");
    expect(
      conversationBody.conversations.map(
        (conversation) => conversation.conversationId,
      ),
    ).toContain("slack:CQA456:1770021600.000600");
    expect(
      conversationBody.conversations.map(
        (conversation) => conversation.conversationId,
      ),
    ).toContain(DASHBOARD_QA_CONVERSATION_ID);
    const qaActivityOnlySession = conversationBody.conversations.find(
      (conversation) =>
        conversation.conversationId === DASHBOARD_QA_CONVERSATION_ID &&
        conversation.id === "mock-dashboard-qa-activity-only",
    );
    expect(qaActivityOnlySession).toBeDefined();
    expect(qaActivityOnlySession).not.toHaveProperty("activity");
    const conversationStats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );
    expect(conversationStats.status).toBe(200);
    const statsBody = (await conversationStats.json()) as {
      conversations: number;
      durationMs: number;
      sampleSize: number;
      truncated: boolean;
    };
    expect(statsBody).toMatchObject({
      conversations: new Set(
        conversationBody.conversations.map(
          (conversation) => conversation.conversationId,
        ),
      ).size,
      sampleSize: conversationBody.conversations.length,
      truncated: false,
    });
    const rawDurationMs = conversationBody.conversations.reduce(
      (sum, conversation) => sum + conversation.cumulativeDurationMs,
      0,
    );
    expect(statsBody.durationMs).toBeLessThan(rawDurationMs);

    const activeConversation = await app.fetch(
      new Request(
        "http://localhost/api/conversations/slack%3ACQA123%3A1770003600.000200",
      ),
    );
    expect(activeConversation.status).toBe(200);
    const activeConversationBody = (await activeConversation.json()) as {
      runs: Array<{
        transcript: Array<{
          parts: Array<{ name?: string }>;
        }>;
      }>;
    };
    expect(
      activeConversationBody.runs[0]?.transcript
        .flatMap((message) => message.parts)
        .map((part) => part.name)
        .filter(Boolean),
    ).toContain("datacat.search_logs");

    const qaConversation = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(
          DASHBOARD_QA_CONVERSATION_ID,
        )}`,
      ),
    );
    expect(qaConversation.status).toBe(200);
    const qaConversationBody = (await qaConversation.json()) as {
      runs: Array<{
        activity?: Array<{
          status?: string;
          subagents?: Array<{
            parentToolCallId?: string;
            status?: string;
            subagentKind?: string;
            type: string;
          }>;
          toolCallId?: string;
          toolName?: string;
          type: string;
        }>;
        id?: string;
        transcript: Array<{
          parts: Array<{ id?: string; name?: string; type: string }>;
          timestamp?: number;
        }>;
        transcriptMessageCount?: number;
      }>;
    };
    expect(qaConversationBody.runs[0]).toMatchObject({
      id: "mock-dashboard-qa-activity-only",
      transcript: [],
      transcriptMessageCount: 3,
      activity: [
        {
          type: "tool_execution",
          status: "running",
          toolName: "mock.dashboard_running_tool",
        },
      ],
    });
    const invertedRun = qaConversationBody.runs[1];
    expect(invertedRun?.transcript[0]?.parts[0]).toMatchObject({
      type: "tool_call",
      name: "mock.inverted_timestamp_tool",
    });
    expect(invertedRun?.transcript[1]?.parts[0]).toMatchObject({
      type: "tool_result",
      name: "mock.inverted_timestamp_tool",
    });
    expect(invertedRun?.transcript[1]?.timestamp).toBeLessThan(
      invertedRun?.transcript[0]?.timestamp ?? 0,
    );
    const advisorRun = qaConversationBody.runs[2];
    expect(advisorRun?.id).toBe("mock-dashboard-qa-advisor-code-change");
    expect(
      advisorRun?.transcript
        .flatMap((message) => message.parts)
        .filter((part) => part.name === "advisor")
        .map((part) => part.type),
    ).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
    expect(advisorRun?.activity?.[0]).toMatchObject({
      type: "tool_execution",
      status: "completed",
      toolCallId: "toolu_mock_dashboard_advisor_plan",
      toolName: "advisor",
      subagents: [
        {
          type: "subagent",
          status: "completed",
          subagentKind: "advisor",
          parentToolCallId: "toolu_mock_dashboard_advisor_plan",
          transcriptAvailable: true,
        },
      ],
    });
    expect(advisorRun?.activity?.[3]).toMatchObject({
      type: "tool_execution",
      status: "completed",
      toolCallId: "toolu_mock_dashboard_advisor_review",
      toolName: "advisor",
      subagents: [
        {
          type: "subagent",
          status: "completed",
          subagentKind: "advisor",
          parentToolCallId: "toolu_mock_dashboard_advisor_review",
          transcriptAvailable: true,
        },
      ],
    });

    const firstAdvisorTranscript = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(
          DASHBOARD_QA_CONVERSATION_ID,
        )}/runs/mock-dashboard-qa-advisor-code-change/subagents/toolu_mock_dashboard_advisor_plan`,
      ),
    );
    expect(firstAdvisorTranscript.status).toBe(200);
    const firstAdvisorBody =
      (await firstAdvisorTranscript.json()) as DashboardConversationSubagentTranscript;
    expect(firstAdvisorBody.subagentConversationId).toBe(
      "junior:internal:dashboard-qa:advisor_session",
    );
    expect(firstAdvisorBody.subagentSentryConversationUrl).toContain(
      encodeURIComponent("junior:internal:dashboard-qa:advisor_session"),
    );
    expect(firstAdvisorBody.transcriptAvailable).toBe(true);
    expect(JSON.stringify(firstAdvisorBody.transcript)).toContain(
      "Review the dashboard plan before editing",
    );
    expect(JSON.stringify(firstAdvisorBody.transcript)).not.toContain(
      "Review the implementation after the first advisor pass",
    );

    const secondAdvisorTranscript = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(
          DASHBOARD_QA_CONVERSATION_ID,
        )}/runs/mock-dashboard-qa-advisor-code-change/subagents/toolu_mock_dashboard_advisor_review`,
      ),
    );
    expect(secondAdvisorTranscript.status).toBe(200);
    const secondAdvisorBody =
      (await secondAdvisorTranscript.json()) as DashboardConversationSubagentTranscript;
    expect(JSON.stringify(secondAdvisorBody.transcript)).toContain(
      "Review the dashboard plan before editing",
    );
    expect(JSON.stringify(secondAdvisorBody.transcript)).toContain(
      "Review the implementation after the first advisor pass",
    );

    const longConversation = await app.fetch(
      new Request(
        "http://localhost/api/conversations/slack%3ACQA456%3A1770021600.000600",
      ),
    );
    expect(longConversation.status).toBe(200);
    const longConversationBody = (await longConversation.json()) as {
      runs: Array<{
        transcript: Array<{
          role: string;
          parts: Array<{ id?: string; name?: string; type: string }>;
          timestamp?: number;
        }>;
        transcriptMessageCount?: number;
      }>;
    };
    const longConversationParts = longConversationBody.runs.flatMap((turn) =>
      turn.transcript.flatMap((message) => message.parts),
    );
    const systemMessages = longConversationBody.runs.flatMap((turn) =>
      turn.transcript.filter((message) => message.role === "system"),
    );
    const bashCallTimes = new Map<string, number>();
    const bashDurations = longConversationBody.runs.flatMap((turn) =>
      turn.transcript.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.name !== "bash" || !part.id || !message.timestamp) {
            return [];
          }
          if (part.type === "tool_call") {
            bashCallTimes.set(part.id, message.timestamp);
            return [];
          }
          const startedAt = bashCallTimes.get(part.id);
          return startedAt === undefined ? [] : [message.timestamp - startedAt];
        }),
      ),
    );
    expect(longConversationBody.runs).toHaveLength(2);
    expect(systemMessages).toHaveLength(1);
    expect(longConversationBody.runs[1]?.transcript[0]?.role).toBe("user");
    for (const turn of longConversationBody.runs) {
      expect(turn.transcriptMessageCount).toBe(turn.transcript.length);
    }
    expect(
      longConversationParts.filter((part) => part.name === "bash").length,
    ).toBeGreaterThan(20);
    expect(new Set(bashDurations).size).toBeGreaterThan(8);
    expect(Math.max(...bashDurations)).toBeGreaterThan(10_000);
    expect(longConversationParts.some((part) => part.type === "thinking")).toBe(
      true,
    );

    const conversation = await app.fetch(
      new Request(
        "http://localhost/api/conversations/slack%3ADQA123%3A1770007200.000300",
      ),
    );
    expect(conversation.status).toBe(200);
    const redactedConversationBody = (await conversation.json()) as {
      runs: Array<{
        transcriptAvailable: boolean;
        transcriptMetadata?: Array<{ role: string }>;
        transcriptRedacted?: boolean;
      }>;
    };
    expect(redactedConversationBody).toMatchObject({
      conversationId: "slack:DQA123:1770007200.000300",
      runs: [
        {
          transcriptAvailable: false,
          transcriptRedacted: true,
          transcript: [],
        },
      ],
    });
    expect(
      redactedConversationBody.runs[0]?.transcriptMetadata?.[0]?.role,
    ).toBe("user");
  });

  it("serves mock conversations when local persistence is unavailable", async () => {
    const mockReporting = reporting();
    mockReporting.listConversations = async () => {
      throw new Error("REDIS_URL is required for durable Slack thread state");
    };
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
      reporting: mockReporting,
    });

    const response = await app.fetch(
      new Request("http://localhost/api/conversations"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversations: Array<{ conversationId: string; status: string }>;
      source: string;
    };
    expect(body.source).toBe("conversation_index");
    expect(body.conversations[0]).toMatchObject({
      conversationId: "slack:CQA123:1770003600.000200",
      status: "active",
    });
    const stats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );
    expect(stats.status).toBe(200);
    expect(await stats.json()).toMatchObject({
      conversations: expect.any(Number),
      truncated: false,
    });
  });

  it("excludes stale real conversations from mock aggregate stats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const mockReporting = reporting();
    mockReporting.listConversations = async () => ({
      source: "conversation_index",
      generatedAt: "2026-06-04T12:00:00.000Z",
      conversations: [
        {
          conversationId: "slack:COLD:111",
          cumulativeDurationMs: 1_000_000,
          id: "old-real-turn",
          lastProgressAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:00:00.000Z",
          startedAt: "2026-05-01T00:00:00.000Z",
          status: "completed",
          surface: "slack",
          displayTitle: "Old real turn",
        },
      ],
    });
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
      reporting: mockReporting,
    });

    const conversations = await app.fetch(
      new Request("http://localhost/api/conversations"),
    );
    const conversationBody = (await conversations.json()) as {
      conversations: Array<{ conversationId: string; lastSeenAt: string }>;
    };
    expect(
      conversationBody.conversations.map((session) => session.conversationId),
    ).toContain("slack:COLD:111");

    const stats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );
    const statsBody = (await stats.json()) as { conversations: number };
    const windowStartMs =
      Date.parse("2026-06-04T12:00:00.000Z") - 7 * 24 * 60 * 60 * 1000;
    const recentConversationIds = new Set(
      conversationBody.conversations
        .filter((session) => Date.parse(session.lastSeenAt) >= windowStartMs)
        .map((session) => session.conversationId),
    );

    expect(statsBody.conversations).toBe(recentConversationIds.size);
  });

  it("does not hide unexpected reporting errors in mock mode", async () => {
    const mockReporting = reporting();
    mockReporting.listConversations = async () => {
      throw new Error("session index corrupted");
    };

    await expect(
      createMockConversationReporting(mockReporting).listConversations(),
    ).rejects.toThrow("session index corrupted");
  });
});
