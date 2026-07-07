import type { JuniorReporting } from "@sentry/junior/reporting";
import type { ActorDirectoryReport } from "@sentry/junior/api/people/list";
import type { ActorProfileReport } from "@sentry/junior/api/people/profile";

/** Provide the minimal dashboard reporting surface unrelated API routes need. */
export function dashboardReporting(): JuniorReporting {
  return {
    async getHealth() {
      return {
        service: "junior",
        status: "ok",
        timestamp: "2026-06-15T12:00:00.000Z",
      };
    },
    async getRuntimeInfo() {
      return {
        cwd: "/workspace",
        homeDir: "/workspace",
        packagedContent: {
          manifestRoots: [],
          packageNames: [],
          packages: [],
          skillRoots: [],
          tracingIncludes: [],
        },
        plugins: [],
        providers: [],
        skills: [],
      };
    },
    async getPlugins() {
      return [];
    },
    async getSkills() {
      return [];
    },
    async listConversations() {
      return {
        conversations: [],
        generatedAt: "2026-06-15T12:00:00.000Z",
        source: "conversation_index",
        truncated: false,
      };
    },
    async getConversation(conversationId) {
      return {
        conversationId,
        displayTitle: "Conversation",
        generatedAt: "2026-06-15T12:00:00.000Z",
        runs: [],
      };
    },
    async getConversationSubagentTranscript(
      _conversationId,
      _runId,
      subagentId,
    ) {
      return {
        createdAt: "2026-06-15T12:00:00.000Z",
        id: subagentId,
        status: "running",
        subagentKind: "agent",
        transcript: [],
        transcriptAvailable: false,
        type: "subagent",
      };
    },
  };
}

/** Return the fixture response for the people list route. */
export function directoryReport(): ActorDirectoryReport {
  return {
    generatedAt: "2026-06-15T12:00:00.000Z",
    people: [
      {
        active: 0,
        activeDays: 1,
        conversations: 2,
        durationMs: 0,
        failed: 0,
        firstSeenAt: "2026-06-10T10:03:00.000Z",
        hung: 0,
        lastSeenAt: "2026-06-12T11:01:00.000Z",
        actor: {
          email: "person@example.com",
          fullName: "Person Example",
        },
        runs: 2,
      },
    ],
    sampleLimit: 5000,
    sampleSize: 1,
    source: "conversation_index",
    truncated: false,
  };
}

/** Return the fixture response for the people profile route. */
export async function profileReport(
  email: string,
): Promise<ActorProfileReport> {
  return {
    activityDays: [],
    generatedAt: "2026-06-15T12:00:00.000Z",
    locations: [],
    recentConversations: [],
    actor: { email },
    sampleLimit: 5000,
    sampleSize: 1,
    source: "conversation_index",
    surfaces: [],
    totals: {
      active: 0,
      activeDays: 1,
      conversations: 1,
      durationMs: 0,
      failed: 0,
      hung: 0,
      runs: 1,
    },
    truncated: false,
    windowEnd: "2026-06-15T00:00:00.000Z",
    windowStart: "2025-06-15T00:00:00.000Z",
  };
}
