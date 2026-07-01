import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversationDetailsForIds } from "@/chat/state/conversation-details";
import { listAgentTurnSessionSummariesForConversation } from "@/chat/state/turn-session";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import {
  readConversationFeed,
  readConversationReport,
  readRequesterDirectoryReport,
  readRequesterProfileReport,
} from "@/reporting/conversations";

vi.mock("@/chat/sentry", () => ({
  getActiveSpan: () => undefined,
  getClient: () => ({
    getDsn: () => ({
      host: "sentry.io",
      projectId: "4501",
      protocol: "https",
    }),
  }),
  spanToJSON: () => ({}),
}));

vi.mock("@/chat/prompt", () => ({
  buildSystemPrompt: vi.fn(() => "[system prompt]"),
  buildTurnContextPrompt: vi.fn(() => null),
  JUNIOR_PERSONALITY: "",
  JUNIOR_WORLD: null,
}));

vi.mock("@/chat/state/conversation-details", () => ({
  getConversationDetails: vi.fn(async () => undefined),
  getConversationDetailsForIds: vi.fn(async () => new Map()),
}));

vi.mock("@/chat/state/turn-session", () => ({
  getAgentTurnSessionRecord: vi.fn(async () => undefined),
  listAgentTurnSessionSummariesForConversation: vi.fn(async () => []),
}));

const ORIGINAL_SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG;

function fixedConversationStore(
  conversations: Conversation[],
): ConversationStore {
  return {
    async get(args) {
      return conversations.find(
        (conversation) => conversation.conversationId === args.conversationId,
      );
    },
    async recordActivity() {},
    async recordExecution() {},
    async listByActivity(args = {}) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? conversations.length;
      return conversations
        .slice()
        .sort(
          (left, right) =>
            right.lastActivityAtMs - left.lastActivityAtMs ||
            left.conversationId.localeCompare(right.conversationId),
        )
        .slice(offset, offset + limit);
    },
  };
}

function indexedConversation(
  input: Partial<Conversation> &
    Pick<Conversation, "conversationId" | "createdAtMs" | "lastActivityAtMs">,
): Conversation {
  return {
    schemaVersion: 1,
    ...input,
    updatedAtMs: input.lastActivityAtMs,
    execution: {
      status: "idle",
      updatedAtMs: input.lastActivityAtMs,
      ...input.execution,
    },
  };
}

afterEach(() => {
  vi.mocked(getConversationDetailsForIds).mockResolvedValue(new Map());
  vi.mocked(listAgentTurnSessionSummariesForConversation).mockResolvedValue([]);
  if (ORIGINAL_SENTRY_ORG_SLUG === undefined) {
    delete process.env.SENTRY_ORG_SLUG;
  } else {
    process.env.SENTRY_ORG_SLUG = ORIGINAL_SENTRY_ORG_SLUG;
  }
});

describe("conversation reporting", () => {
  it("returns Sentry conversation URLs only on detail reports", async () => {
    process.env.SENTRY_ORG_SLUG = "acme";
    const conversationStore = fixedConversationStore([
      indexedConversation({
        conversationId: "slack:C1:123",
        createdAtMs: 1_000,
        lastActivityAtMs: 2_000,
      }),
    ]);

    const feed = await readConversationFeed({ conversationStore });
    const detail = await readConversationReport("slack:C1:123", {
      conversationStore,
    });

    expect(feed.conversations[0]).not.toHaveProperty("sentryConversationUrl");
    expect(detail.sentryConversationUrl).toBe(
      "https://acme.sentry.io/explore/conversations/slack%3AC1%3A123/?project=4501",
    );
  });

  it("aggregates requester profiles by trusted email", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const conversationStore = fixedConversationStore([
      indexedConversation({
        conversationId: "slack:C1:123",
        channelName: "proj-alpha",
        createdAtMs: Date.parse("2026-06-10T10:00:00.000Z"),
        lastActivityAtMs: Date.parse("2026-06-10T10:03:00.000Z"),
        requester: {
          email: "Alice@Example.com",
          fullName: "Alice Example",
          slackUserId: "U1",
          slackUserName: "alice",
        },
        source: "slack",
      }),
      indexedConversation({
        conversationId: "slack:C1:456",
        createdAtMs: Date.parse("2026-06-12T11:00:00.000Z"),
        execution: {
          status: "failed",
          updatedAtMs: Date.parse("2026-06-12T11:01:00.000Z"),
        },
        lastActivityAtMs: Date.parse("2026-06-12T11:01:00.000Z"),
        requester: {
          email: "alice@example.com",
          slackUserId: "U1",
        },
        source: "slack",
      }),
      indexedConversation({
        conversationId: "slack:C2:789",
        createdAtMs: Date.parse("2026-06-13T11:00:00.000Z"),
        lastActivityAtMs: Date.parse("2026-06-13T11:01:00.000Z"),
        requester: {
          email: "bob@example.com",
          fullName: "Bob Example",
          slackUserId: "U2",
        },
        source: "slack",
      }),
      indexedConversation({
        conversationId: "slack:C1:999",
        createdAtMs: Date.parse("2026-06-11T09:00:00.000Z"),
        lastActivityAtMs: Date.parse("2026-06-11T09:04:00.000Z"),
        requester: {
          email: "later@example.com",
          fullName: "Later Assignee",
          slackUserId: "U9",
        },
        source: "slack",
      }),
      indexedConversation({
        conversationId: "slack:C3:000",
        createdAtMs: Date.parse("2026-06-14T11:00:00.000Z"),
        lastActivityAtMs: Date.parse("2026-06-14T11:01:00.000Z"),
        requester: {
          fullName: "No Email",
          slackUserId: "U3",
        },
        source: "slack",
      }),
    ]);
    vi.mocked(getConversationDetailsForIds).mockResolvedValue(
      new Map([
        [
          "slack:C1:999",
          {
            conversationId: "slack:C1:999",
            originRequester: {
              email: "alice@example.com",
              fullName: "Alice Origin",
              slackUserId: "U1",
            },
          },
        ],
      ]),
    );

    const directory = await readRequesterDirectoryReport({
      conversationStore,
    });
    const profile = await readRequesterProfileReport("ALICE@example.com", {
      conversationStore,
    });

    expect(directory.people.map((person) => person.requester.email)).toEqual([
      "bob@example.com",
      "alice@example.com",
    ]);
    expect(
      directory.people.find(
        (person) => person.requester.email === "alice@example.com",
      ),
    ).toMatchObject({
      activeDays: 3,
      conversations: 3,
      failed: 1,
      requester: {
        email: "alice@example.com",
        fullName: "Alice Origin",
      },
    });
    expect(profile).toMatchObject({
      requester: {
        email: "alice@example.com",
        fullName: "Alice Origin",
      },
      totals: {
        activeDays: 3,
        conversations: 3,
        failed: 1,
        runs: 3,
      },
      locations: [
        expect.objectContaining({
          conversations: 2,
          label: "Public Channel",
        }),
        expect.objectContaining({
          conversations: 1,
          label: "#proj-alpha",
        }),
      ],
    });
    expect(profile.activityDays).toHaveLength(366);
    expect(
      profile.activityDays.find((day) => day.date === "2026-06-12"),
    ).toMatchObject({
      conversations: 1,
      failed: 1,
    });
    expect(
      profile.recentConversations.map((item) => item.conversationId),
    ).toEqual(["slack:C1:456", "slack:C1:999", "slack:C1:123"]);
  });

  it("aligns requester directory totals with stored turn summaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const startedAtMs = Date.parse("2026-06-15T11:00:00.000Z");
    const conversationStore = fixedConversationStore([
      indexedConversation({
        conversationId: "slack:C1:turns",
        createdAtMs: startedAtMs,
        lastActivityAtMs: startedAtMs + 2_000,
        requester: {
          email: "avery@example.com",
          fullName: "Avery",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        source: "slack",
      }),
    ]);
    vi.mocked(
      listAgentTurnSessionSummariesForConversation,
    ).mockResolvedValueOnce([
      {
        conversationId: "slack:C1:turns",
        cumulativeDurationMs: 1_000,
        lastProgressAtMs: startedAtMs + 500,
        requester: {
          email: "avery@example.com",
          fullName: "Avery",
          platform: "slack",
          teamId: "T1",
          userId: "U1",
        },
        sessionId: "turn-1",
        sliceId: 1,
        startedAtMs,
        state: "completed",
        updatedAtMs: startedAtMs + 500,
        version: 1,
      },
      {
        conversationId: "slack:C1:turns",
        cumulativeDurationMs: 2_000,
        lastProgressAtMs: startedAtMs + 2_000,
        requester: {
          email: "avery@example.com",
          fullName: "Avery",
          platform: "slack",
          teamId: "T1",
          userId: "U1",
        },
        sessionId: "turn-2",
        sliceId: 1,
        startedAtMs: startedAtMs + 1_000,
        state: "completed",
        updatedAtMs: startedAtMs + 2_000,
        version: 1,
      },
    ]);

    const directory = await readRequesterDirectoryReport({
      conversationStore,
    });

    expect(directory.people).toHaveLength(1);
    expect(directory.people[0]).toMatchObject({
      conversations: 1,
      durationMs: 2_000,
      requester: {
        email: "avery@example.com",
      },
      runs: 2,
    });
  });
});
