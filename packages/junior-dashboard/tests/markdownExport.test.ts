import { describe, expect, it } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import { buildConversationMarkdown } from "../src/client/markdownExport";
import type { ConversationTranscript } from "../src/client/types";

function event(
  seq: number,
  data: ConversationReportEventData,
): ConversationReportEvent {
  return {
    seq,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    data,
  };
}

function conversation(
  events: ConversationReportEvent[],
  overrides: Partial<ConversationTranscript> = {},
): ConversationTranscript {
  return {
    actorIdentity: { email: "alice@example.com" },
    channel: "C1",
    channelName: "proj-alpha",
    conversationId: "conversation-1",
    cumulativeDurationMs: 3_000,
    displayTitle: "Canonical conversation",
    eventHistory: { status: "available" },
    events,
    generatedAt: "2026-01-01T00:01:00.000Z",
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "slack",
    ...overrides,
  };
}

describe("dashboard canonical-event Markdown export", () => {
  it("exports visible user and assistant messages", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "message",
          messageId: "user-1",
          role: "user",
          text: "please investigate",
        }),
        event(2, {
          type: "message",
          messageId: "assistant-1",
          role: "assistant",
          text: "investigation complete",
        }),
      ]),
    );

    expect(markdown).toContain("# Canonical conversation");
    expect(markdown).toContain("### alice@example.com");
    expect(markdown).toContain("please investigate");
    expect(markdown).toContain("### Junior");
    expect(markdown.match(/investigation complete/g)).toHaveLength(1);
  });

  it("exports structural tool, context, subagent, and failure rows", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "tool_started",
          toolCallId: "search-1",
          name: "search",
        }),
        event(1, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              input: { query: "release regression" },
            },
          ],
        }),
        event(2, {
          type: "tool_result",
          toolCallId: "search-1",
          outcome: "completed",
          output: { matches: 3 },
        }),
        event(3, {
          type: "subagent_started",
          childConversationId: "child-1",
          subagentKind: "advisor",
        }),
        event(4, { type: "compaction" }),
        event(5, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
          failureKind: "agent",
        }),
      ]),
    );

    expect(markdown).toContain("### Tool: search");
    expect(markdown).toContain("- Status: completed");
    expect(markdown.match(/### Tool: search/g)).toHaveLength(1);
    expect(markdown).toContain("release regression");
    expect(markdown).toContain('"matches": 3');
    expect(markdown).toContain("### Subagent: advisor");
    expect(markdown).toContain("### Context compacted");
    expect(markdown).toContain("### Agent response failed");
    expect(markdown).not.toContain("missing");
    expect(markdown).not.toContain("Result: running");
  });

  it("exports a delivery terminal failure without mislabeling it as an agent failure", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
          failureKind: "delivery",
        }),
      ]),
    );

    expect(markdown).toContain("### Message delivery failed");
    expect(markdown).toContain(
      "Junior could not deliver this message to its destination.",
    );
    expect(markdown).not.toContain("turn-1");
    expect(markdown).not.toContain("Agent response failed");
  });

  it("labels redacted in-progress tools without inventing a completion", () => {
    const markdown = buildConversationMarkdown(
      conversation(
        [
          event(0, {
            type: "tool_started",
            toolCallId: "search-1",
            name: "search",
          }),
        ],
        {
          eventHistory: {
            status: "redacted",
            reason: "non_public_conversation",
          },
        },
      ),
    );

    expect(markdown).toContain("### Tool: search");
    expect(markdown).toContain("- Status: running");
    expect(markdown).not.toContain("missing result");
  });

  it("exports only safe placeholders for redacted event history", () => {
    const markdown = buildConversationMarkdown(
      conversation(
        [
          event(0, {
            type: "message",
            messageId: "private-user",
            role: "user",
            redacted: true,
          }),
        ],
        {
          eventHistory: {
            status: "redacted",
            reason: "non_public_conversation",
          },
        },
      ),
    );

    expect(markdown).toContain(
      "Transcript hidden because this conversation is not public.",
    );
    expect(markdown).toContain("<redacted>");
  });

  it("explains expired event history", () => {
    const markdown = buildConversationMarkdown(
      conversation([], {
        eventHistory: {
          status: "expired",
          expiredAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    expect(markdown).toContain("Transcript expired for this conversation.");
  });
});
