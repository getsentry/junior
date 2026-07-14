import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorDirectoryReportSchema,
  conversationSubagentTranscriptReportSchema,
  type ConversationSubagentTranscriptReport,
} from "@sentry/junior/api/schema";
import { createDashboardApp } from "../src/app";
import { DASHBOARD_QA_CONVERSATION_ID } from "../src/mock-conversations";

describe("dashboard mock conversation routes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("overlays mock conversations for local dashboard visual QA", async () => {
    // Pin time to match the hardcoded conversation dates in the mock reporting fixture.
    // Without this, recentConversationGroups filters out conversations older than 90 days.
    vi.useFakeTimers({ now: new Date("2026-05-30T00:00:00.000Z") });
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
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
      }>;
    };
    expect(conversationBody.conversations[0]?.conversationId).toBe(
      "slack:CQA123:1770003600.000200",
    );
    const personalConversations = await app.fetch(
      new Request(
        "http://localhost/api/conversations?actorEmail=morgan%40sentry.io",
      ),
    );
    expect(personalConversations.status).toBe(200);
    const personalBody = (await personalConversations.json()) as {
      conversations: Array<{
        actorIdentity?: { email?: string };
        conversationId: string;
      }>;
    };
    expect(personalBody.conversations.length).toBeGreaterThan(0);
    expect(
      personalBody.conversations.every(
        (conversation) =>
          conversation.actorIdentity?.email === "morgan@sentry.io",
      ),
    ).toBe(true);
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
    const qaConversationSummary = conversationBody.conversations.find(
      (conversation) =>
        conversation.conversationId === DASHBOARD_QA_CONVERSATION_ID,
    );
    expect(qaConversationSummary).toBeDefined();
    expect(qaConversationSummary).not.toHaveProperty("activity");
    const conversationStats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );
    expect(conversationStats.status).toBe(200);
    const statsBody = (await conversationStats.json()) as {
      conversations: number;
      costUsd?: number;
      durationMs: number;
      windowEnd: string;
      windowStart: string;
    };
    expect(statsBody).toMatchObject({
      conversations: new Set(
        conversationBody.conversations.map(
          (conversation) => conversation.conversationId,
        ),
      ).size,
    });
    const rawDurationMs = conversationBody.conversations.reduce(
      (sum, conversation) => sum + conversation.cumulativeDurationMs,
      0,
    );
    expect(statsBody.durationMs).toBe(rawDurationMs);
    expect(statsBody.costUsd).toBeGreaterThan(0);
    expect(
      Date.parse(statsBody.windowEnd) - Date.parse(statsBody.windowStart),
    ).toBe(90 * 24 * 60 * 60 * 1000);

    const locations = await app.fetch(
      new Request("http://localhost/api/locations"),
    );
    expect(locations.status).toBe(200);
    const locationBody = (await locations.json()) as {
      locations: Array<{ id: string; label: string }>;
      privateActivity: { conversations: number };
    };
    expect(locationBody.locations.length).toBeGreaterThan(0);
    expect(locationBody.locations.map((location) => location.label)).toContain(
      "#proj-checkout",
    );
    expect(locationBody.privateActivity.conversations).toBeGreaterThan(0);
    const locationDetail = await app.fetch(
      new Request(
        `http://localhost/api/locations/${encodeURIComponent(locationBody.locations[0]!.id)}`,
      ),
    );
    expect(locationDetail.status).toBe(200);
    await expect(locationDetail.json()).resolves.toMatchObject({
      visibility: "public",
      activityDays: expect.any(Array),
      recentConversations: expect.any(Array),
    });

    const people = await app.fetch(new Request("http://localhost/api/people"));
    expect(people.status).toBe(200);
    const peopleBody = actorDirectoryReportSchema.parse(await people.json());
    const actorEmail = peopleBody.people[0]!.actor.email;
    const personProfile = await app.fetch(
      new Request(
        `http://localhost/api/people/${encodeURIComponent(actorEmail)}`,
      ),
    );
    expect(personProfile.status).toBe(200);
    await expect(personProfile.json()).resolves.toMatchObject({
      activityDays: expect.any(Array),
      actor: { email: actorEmail },
      recentConversations: expect.any(Array),
    });

    const activeConversation = await app.fetch(
      new Request(
        "http://localhost/api/conversations/slack%3ACQA123%3A1770003600.000200",
      ),
    );
    expect(activeConversation.status).toBe(200);
    const activeConversationBody = (await activeConversation.json()) as {
      transcript: Array<{
        parts: Array<{ name?: string }>;
      }>;
    };
    expect(
      activeConversationBody.transcript
        .flatMap((message) => message.parts)
        .map((part) => part.name)
        .filter(Boolean),
    ).toContain("datacat.search_logs");

    const failedConversation = await app.fetch(
      new Request(
        "http://localhost/api/conversations/slack%3ACQA777%3A1770014400.000500",
      ),
    );
    expect(failedConversation.status).toBe(200);
    const failedConversationBody = (await failedConversation.json()) as {
      transcript: Array<{
        outcome?: string;
        parts: unknown[];
        role: string;
      }>;
      transcriptMessageCount?: number;
    };
    expect(failedConversationBody.transcript.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        outcome: "error",
        parts: [],
      }),
    );
    expect(failedConversationBody.transcriptMessageCount).toBe(3);

    const qaConversation = await app.fetch(
      new Request(
        `http://localhost/api/conversations/${encodeURIComponent(
          DASHBOARD_QA_CONVERSATION_ID,
        )}`,
      ),
    );
    expect(qaConversation.status).toBe(200);
    const qaConversationBody = (await qaConversation.json()) as {
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
      conversationId: string;
      transcript: Array<{
        parts: Array<{ id?: string; name?: string; type: string }>;
        timestamp?: number;
      }>;
      transcriptMessageCount?: number;
    };
    expect(qaConversationBody.activity?.[0]).toMatchObject({
      type: "tool_execution",
      status: "running",
      toolName: "mock.dashboard_running_tool",
    });
    const invertedMessages = qaConversationBody.transcript.filter((message) =>
      message.parts.some(
        (part) => part.name === "mock.inverted_timestamp_tool",
      ),
    );
    expect(invertedMessages[0]?.parts[0]).toMatchObject({
      type: "tool_call",
      name: "mock.inverted_timestamp_tool",
    });
    expect(invertedMessages[1]?.parts[0]).toMatchObject({
      type: "tool_result",
      name: "mock.inverted_timestamp_tool",
    });
    expect(invertedMessages[1]?.timestamp).toBeLessThan(
      invertedMessages[0]?.timestamp ?? 0,
    );
    expect(qaConversationBody.conversationId).toBe("internal:dashboard-qa");
    expect(
      qaConversationBody.transcript
        .flatMap((message) => message.parts)
        .filter((part) => part.name === "advisor")
        .map((part) => part.type),
    ).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
    expect(
      qaConversationBody.activity?.find(
        (activity) =>
          activity.toolCallId === "toolu_mock_dashboard_advisor_plan",
      ),
    ).toMatchObject({
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
    expect(
      qaConversationBody.activity?.find(
        (activity) =>
          activity.toolCallId === "toolu_mock_dashboard_advisor_review",
      ),
    ).toMatchObject({
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
        )}/subagents/toolu_mock_dashboard_advisor_plan`,
      ),
    );
    expect(firstAdvisorTranscript.status).toBe(200);
    const firstAdvisorBody =
      (await firstAdvisorTranscript.json()) as ConversationSubagentTranscriptReport;
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
        )}/subagents/toolu_mock_dashboard_advisor_review`,
      ),
    );
    expect(secondAdvisorTranscript.status).toBe(200);
    const secondAdvisorBody =
      (await secondAdvisorTranscript.json()) as ConversationSubagentTranscriptReport;
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
      contextEvents?: Array<{ summary?: string; type: string }>;
      transcript: Array<{
        role: string;
        parts: Array<{ id?: string; name?: string; type: string }>;
        timestamp?: number;
      }>;
      transcriptMessageCount?: number;
    };
    const longConversationParts = longConversationBody.transcript.flatMap(
      (message) => message.parts,
    );
    const systemMessages = longConversationBody.transcript.filter(
      (message) => message.role === "system",
    );
    const bashCallTimes = new Map<string, number>();
    const bashDurations = longConversationBody.transcript.flatMap((message) =>
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
    );
    expect(systemMessages).toHaveLength(1);
    expect(longConversationBody.contextEvents).toEqual([
      expect.objectContaining({ type: "context_compacted" }),
      expect.objectContaining({ type: "model_handoff" }),
    ]);
    expect(longConversationBody.transcriptMessageCount).toBe(
      longConversationBody.transcript.length,
    );
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
      transcriptAvailable: boolean;
      transcriptMetadata?: Array<{ role: string }>;
      transcriptRedacted?: boolean;
    };
    expect(redactedConversationBody).toMatchObject({
      conversationId: "slack:DQA123:1770007200.000300",
      transcriptAvailable: false,
      transcriptRedacted: true,
      transcript: [],
    });
    expect(redactedConversationBody.transcriptMetadata?.[0]?.role).toBe("user");
  });

  it("serves explicit mock conversation data", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
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
    });
  });

  it("returns the canonical subagent not-found response", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      mockConversations: true,
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/conversations/missing/subagents/missing-child",
      ),
    );

    expect(response.status).toBe(404);
    expect(
      conversationSubagentTranscriptReportSchema.parse(await response.json()),
    ).toMatchObject({
      id: "missing-child",
      transcript: [],
      transcriptAvailable: false,
      unavailableReason: "not_found",
    });
  });
});
