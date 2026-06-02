import { describe, expect, it } from "vitest";
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
  it("overlays mock conversations for local dashboard visual QA", async () => {
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
      sessions: Array<{ conversationId: string }>;
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
