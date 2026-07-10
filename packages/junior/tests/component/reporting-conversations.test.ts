import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import type { PiMessage } from "@/chat/pi/messages";
import {
  readConversationFeed,
  readConversationReport,
} from "@/reporting/conversations";
import { getAgentStepStore } from "@/chat/db";

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
    async getDestinationVisibility() {
      return undefined;
    },
    async ensureChildConversation() {},
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
  it("reports the SQL projection when transient turn metadata is absent", async () => {
    const conversationId = "slack:C1:123";
    const conversationStore = fixedConversationStore([
      indexedConversation({
        conversationId,
        createdAtMs: 1_000,
        lastActivityAtMs: 2_000,
        visibility: "public",
      }),
    ]);
    const stepStore = getAgentStepStore();
    await stepStore.append(conversationId, [
      {
        entry: {
          type: "pi_message",
          message: {
            role: "user",
            content: [{ type: "text", text: "durable question" }],
            timestamp: 1_000,
          },
        },
        createdAtMs: 1_000,
      },
      {
        entry: {
          type: "pi_message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "durable answer" }],
            timestamp: 2_000,
          } as unknown as PiMessage,
        },
        createdAtMs: 2_000,
      },
    ]);

    const report = await readConversationReport(conversationId, {
      conversationStore,
    });

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      transcriptAvailable: true,
      transcriptMessageCount: 2,
      transcript: [
        {
          role: "user",
          timestamp: 1_000,
          parts: [{ type: "text", text: "durable question" }],
        },
        {
          role: "assistant",
          timestamp: 2_000,
          parts: [{ type: "text", text: "durable answer" }],
        },
      ],
    });
  });

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

  it("exposes persisted token, reasoning, and cost usage", async () => {
    const { recordAgentTurnSessionSummary } =
      await import("@/chat/state/turn-session");
    const conversationStore = fixedConversationStore([
      indexedConversation({
        conversationId: "slack:C1:456",
        createdAtMs: 1_000,
        execution: {
          runId: "turn-1",
          status: "idle",
          updatedAtMs: 2_000,
        },
        lastActivityAtMs: 2_000,
      }),
    ]);
    await recordAgentTurnSessionSummary({
      conversationId: "slack:C1:456",
      conversationStore,
      cumulativeDurationMs: 1_500,
      cumulativeUsage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        totalTokens: 120,
        cost: {
          input: 0.001,
          output: 0.002,
          total: 0.003,
        },
      },
      sessionId: "turn-1",
      sliceId: 1,
      startedAtMs: 1_000,
      state: "completed",
    });

    const detail = await readConversationReport("slack:C1:456", {
      conversationStore,
    });

    expect(detail.runs[0]).toMatchObject({
      cumulativeDurationMs: 1_500,
      cumulativeUsage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        totalTokens: 120,
        cost: {
          input: 0.001,
          output: 0.002,
          total: 0.003,
        },
      },
    });
  });
});
