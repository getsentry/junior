import { afterEach, describe, expect, it, vi } from "vitest";
import type { JuniorReporting } from "@sentry/junior/reporting";
import { createDashboardApp } from "../src/app";
import { createMockConversationReporting } from "../src/mock-conversations";

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
    async getSessions() {
      return {
        source: "turn_session_records",
        generatedAt: "2026-05-29T00:00:00.000Z",
        sessions: [
          {
            conversationId: "slack:C1:123",
            cumulativeDurationMs: 0,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            title: "Turn turn-1",
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
        source: "turn_session_records",
        truncated: false,
        turns: 1,
        windowEnd: "2026-05-29T00:00:00.000Z",
        windowStart: "2026-05-22T00:00:00.000Z",
      };
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
        generatedAt: "2026-05-29T00:00:00.000Z",
        turns: [
          {
            conversationId,
            cumulativeDurationMs: 0,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            title: "Turn turn-1",
            channel: "C1",
            transcriptAvailable: true,
            transcript: [],
          },
        ],
      };
    },
  };
}

describe("dashboard mock conversation routes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("overlays mock conversations for local dashboard visual QA", async () => {
    // Pin time to match the hardcoded session dates in the mock reporting fixture.
    // Without this, recentConversationGroups filters out sessions older than 7 days.
    vi.useFakeTimers({ now: new Date("2026-05-30T00:00:00.000Z") });
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
      reporting: reporting(),
    });

    const sessions = await app.fetch(
      new Request("http://localhost/api/dashboard/sessions"),
    );
    expect(sessions.status).toBe(200);
    const sessionBody = (await sessions.json()) as {
      sessions: Array<{ conversationId: string; cumulativeDurationMs: number }>;
    };
    expect(sessionBody.sessions[0]?.conversationId).toBe(
      "slack:CQA123:1770003600.000200",
    );
    expect(
      sessionBody.sessions.map((session) => session.conversationId),
    ).toContain("slack:C1:123");
    expect(
      sessionBody.sessions.map((session) => session.conversationId),
    ).toContain("slack:CQA456:1770021600.000600");
    const conversationStats = await app.fetch(
      new Request("http://localhost/api/dashboard/conversation-stats"),
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
        sessionBody.sessions.map((session) => session.conversationId),
      ).size,
      sampleSize: sessionBody.sessions.length,
      truncated: false,
    });
    const rawDurationMs = sessionBody.sessions.reduce(
      (sum, session) => sum + session.cumulativeDurationMs,
      0,
    );
    expect(statsBody.durationMs).toBeLessThan(rawDurationMs);

    const activeConversation = await app.fetch(
      new Request(
        "http://localhost/api/dashboard/conversations/slack%3ACQA123%3A1770003600.000200",
      ),
    );
    expect(activeConversation.status).toBe(200);
    const activeConversationBody = (await activeConversation.json()) as {
      turns: Array<{
        transcript: Array<{
          parts: Array<{ name?: string }>;
        }>;
      }>;
    };
    expect(
      activeConversationBody.turns[0]?.transcript
        .flatMap((message) => message.parts)
        .map((part) => part.name)
        .filter(Boolean),
    ).toContain("datacat.search_logs");

    const longConversation = await app.fetch(
      new Request(
        "http://localhost/api/dashboard/conversations/slack%3ACQA456%3A1770021600.000600",
      ),
    );
    expect(longConversation.status).toBe(200);
    const longConversationBody = (await longConversation.json()) as {
      turns: Array<{
        transcript: Array<{
          role: string;
          parts: Array<{ id?: string; name?: string; type: string }>;
          timestamp?: number;
        }>;
        transcriptMessageCount?: number;
      }>;
    };
    const longConversationParts = longConversationBody.turns.flatMap((turn) =>
      turn.transcript.flatMap((message) => message.parts),
    );
    const systemMessages = longConversationBody.turns.flatMap((turn) =>
      turn.transcript.filter((message) => message.role === "system"),
    );
    const bashCallTimes = new Map<string, number>();
    const bashDurations = longConversationBody.turns.flatMap((turn) =>
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
    expect(longConversationBody.turns).toHaveLength(2);
    expect(systemMessages).toHaveLength(1);
    expect(longConversationBody.turns[1]?.transcript[0]?.role).toBe("user");
    for (const turn of longConversationBody.turns) {
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
        "http://localhost/api/dashboard/conversations/slack%3ADQA123%3A1770007200.000300",
      ),
    );
    expect(conversation.status).toBe(200);
    const conversationBody = (await conversation.json()) as {
      turns: Array<{
        transcriptAvailable: boolean;
        transcriptMetadata?: Array<{ role: string }>;
        transcriptRedacted?: boolean;
      }>;
    };
    expect(conversationBody).toMatchObject({
      conversationId: "slack:DQA123:1770007200.000300",
      turns: [
        {
          transcriptAvailable: false,
          transcriptRedacted: true,
          transcript: [],
        },
      ],
    });
    expect(conversationBody.turns[0]?.transcriptMetadata?.[0]?.role).toBe(
      "user",
    );
  });

  it("serves mock conversations when local persistence is unavailable", async () => {
    const mockReporting = reporting();
    mockReporting.getSessions = async () => {
      throw new Error("REDIS_URL is required for durable Slack thread state");
    };
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
      reporting: mockReporting,
    });

    const response = await app.fetch(
      new Request("http://localhost/api/dashboard/sessions"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ conversationId: string; status: string }>;
      source: string;
    };
    expect(body.source).toBe("turn_session_records");
    expect(body.sessions[0]).toMatchObject({
      conversationId: "slack:CQA123:1770003600.000200",
      status: "active",
    });
    const stats = await app.fetch(
      new Request("http://localhost/api/dashboard/conversation-stats"),
    );
    expect(stats.status).toBe(200);
    expect(await stats.json()).toMatchObject({
      conversations: expect.any(Number),
      truncated: false,
    });
  });

  it("excludes stale real sessions from mock aggregate stats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    const mockReporting = reporting();
    mockReporting.getSessions = async () => ({
      source: "turn_session_records",
      generatedAt: "2026-06-04T12:00:00.000Z",
      sessions: [
        {
          conversationId: "slack:COLD:111",
          cumulativeDurationMs: 1_000_000,
          id: "old-real-turn",
          lastProgressAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:00:00.000Z",
          startedAt: "2026-05-01T00:00:00.000Z",
          status: "completed",
          surface: "slack",
          title: "Old real turn",
        },
      ],
    });
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
      reporting: mockReporting,
    });

    const sessions = await app.fetch(
      new Request("http://localhost/api/dashboard/sessions"),
    );
    const sessionBody = (await sessions.json()) as {
      sessions: Array<{ conversationId: string; lastSeenAt: string }>;
    };
    expect(
      sessionBody.sessions.map((session) => session.conversationId),
    ).toContain("slack:COLD:111");

    const stats = await app.fetch(
      new Request("http://localhost/api/dashboard/conversation-stats"),
    );
    const statsBody = (await stats.json()) as { conversations: number };
    const windowStartMs =
      Date.parse("2026-06-04T12:00:00.000Z") - 7 * 24 * 60 * 60 * 1000;
    const recentConversationIds = new Set(
      sessionBody.sessions
        .filter((session) => Date.parse(session.lastSeenAt) >= windowStartMs)
        .map((session) => session.conversationId),
    );

    expect(statsBody.conversations).toBe(recentConversationIds.size);
  });

  it("does not hide unexpected reporting errors in mock mode", async () => {
    const mockReporting = reporting();
    mockReporting.getSessions = async () => {
      throw new Error("session index corrupted");
    };

    await expect(
      createMockConversationReporting(mockReporting).getSessions(),
    ).rejects.toThrow("session index corrupted");
  });
});
