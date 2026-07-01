import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import {
  readConversationFeed,
  readConversationReport,
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
});
