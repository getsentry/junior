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
    isParticipant: false,
    lastProgressAt: "2026-01-01T00:00:10.000Z",
    lastSeenAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "slack",
    ...overrides,
  };
}

describe("dashboard canonical-event Markdown export", () => {
  it("rejects partial transcript exports", () => {
    expect(() =>
      buildConversationMarkdown(
        conversation([], { previousCursor: "older-events" }),
      ),
    ).toThrow("Cannot export a partial conversation transcript");
  });

  it("exports visible user and assistant messages", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "message",
          messageId: "user-1",
          role: "user",
          text: "please investigate",
          actorIdentity: {
            fullName: "Taylor Chen",
            slackUserName: "taylor",
          },
        }),
        event(2, {
          type: "message",
          messageId: "assistant-1",
          role: "assistant",
          text: "investigation complete\nfollow-up deployed",
        }),
      ]),
    );

    expect(markdown).toContain("# Canonical conversation");
    expect(markdown).toContain("### Taylor Chen");
    expect(markdown).not.toContain("### alice@example.com");
    expect(markdown).toContain("please investigate");
    expect(markdown).toContain("### Junior");
    expect(markdown.match(/investigation complete/g)).toHaveLength(1);
    expect(markdown).toContain("investigation complete\nfollow-up deployed");
  });

  it("exports recalled memory context with its user message", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "message",
          messageId: "user-1",
          role: "user",
          text: "Prepare the release.",
        }),
        event(1, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "started",
        }),
        event(2, {
          type: "turn_context",
          turnId: "turn-1",
          pluginName: "memory",
          kind: "recall",
          version: 1,
          content: {
            memories: [
              {
                id: "memory-personal",
                content: "Prefers release summaries with risks first.",
                observedAtMs: Date.parse("2026-01-02T00:00:00.000Z"),
                scope: "personal",
                kind: "preference",
              },
              {
                id: "memory-1",
                content: "Release notes live in Notion.",
                observedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
                scope: "conversation",
                kind: "knowledge",
              },
            ],
          },
        }),
      ]),
    );

    expect(markdown).toContain("#### Recalled memories");
    expect(markdown).toContain("Prefers release summaries with risks first.");
    expect(markdown).toContain("`memory-personal`");
    expect(markdown).toContain("Scope: personal");
    expect(markdown).toContain("Release notes live in Notion.");
    expect(markdown).toContain("`memory-1`");
    expect(markdown).toContain("Scope: conversation");
  });

  it("exports recalled memory context on acted-on non-mention inputs", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "message",
          messageId: "context-1",
          role: "user",
          text: "can you clarify that?",
          explicitMention: false,
          actorIdentity: {
            fullName: "Taylor Chen",
            slackUserName: "taylor",
          },
        }),
        event(1, {
          type: "turn_lifecycle",
          turnId: "turn-context",
          state: "started",
          inputMessageIds: ["context-1"],
        }),
        event(2, {
          type: "turn_context",
          turnId: "turn-context",
          pluginName: "memory",
          kind: "recall",
          version: 1,
          content: {
            memories: [
              {
                id: "memory-1",
                content: "Release notes live in Notion.",
                observedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
                scope: "conversation",
                kind: "knowledge",
              },
            ],
          },
        }),
      ]),
    );

    expect(markdown).toContain("### Context from Taylor Chen");
    expect(markdown).toContain("can you clarify that?");
    expect(markdown).toContain("#### Recalled memories");
    expect(markdown).toContain("Release notes live in Notion.");
  });

  it("exports resource events without attributing them to the actor", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "message",
          messageId: "event-1",
          role: "user",
          eventType: "pull_request.merged",
          text: "event details",
        }),
      ]),
    );

    expect(markdown).toContain("### Event: pull_request.merged");
    expect(markdown).toContain("event details");
    expect(markdown).not.toContain("### alice@example.com");
  });

  it("exports structural tool, context, subagent, and failure rows", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
            },
          ],
        }),
        event(1, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "running",
              input: { query: "release regression" },
            },
          ],
        }),
        event(2, {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-1",
              name: "search",
              status: "completed",
              output: { matches: 3 },
            },
          ],
        }),
        event(3, {
          type: "subagent",
          startedSeq: 3,
          startedAt: "2026-01-01T00:00:00.000Z",
          childConversationId: "child-1",
          subagentKind: "advisor",
          status: "running",
        }),
        event(4, {
          type: "compaction",
          modelProfile: "standard",
          modelId: "openai/gpt-5.4",
          summary: "Keep the release state and continue monitoring CI.",
          details: {
            reason: "capacity",
            estimatedInputTokens: 361_000,
            replacementInputTokens: 2_400,
            triggerTokens: 360_000,
            inputLimitTokens: 380_000,
            inputMessageCount: 42,
            retainedMessageCount: 2,
            summaryChars: 1_200,
          },
        }),
        event(5, {
          type: "handoff",
          modelProfile: "fast",
          modelId: "openai/gpt-5-mini",
          reasoningLevel: "medium",
          summary: "Investigate the remaining deployment failure.",
        }),
        event(6, {
          type: "turn_lifecycle",
          turnId: "turn-1",
          state: "failed",
          failureCode: "model_execution_failed",
          failureReason: "network",
          eventId: "0123456789abcdef0123456789abcdef",
          sentryEventUrl:
            "https://my-org.sentry.io/issues/?project=4501&query=0123456789abcdef0123456789abcdef",
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
    expect(markdown).toContain("- Estimated input tokens: 361000");
    expect(markdown).toContain("- Compaction trigger: 360000");
    expect(markdown).toContain("- Input limit: 380000");
    expect(markdown).toContain("#### Continuation summary");
    expect(markdown).toContain(
      "Keep the release state and continue monitoring CI.",
    );
    expect(markdown).toContain("### Model handoff");
    expect(markdown).toContain("- Profile: fast");
    expect(markdown).toContain("- Model: openai/gpt-5-mini");
    expect(markdown).toContain("- Reasoning: medium");
    expect(markdown).toContain("Investigate the remaining deployment failure.");
    expect(markdown).toContain("### Model connection failed");
    expect(markdown).toContain("- Code: model_execution_failed");
    expect(markdown).toContain("- Reason: network");
    expect(markdown).toContain(
      "- Event id: [0123456789abcdef0123456789abcdef](https://my-org.sentry.io/issues/?project=4501&query=0123456789abcdef0123456789abcdef)",
    );
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
          failureCode: "delivery_failed",
        }),
      ]),
    );

    expect(markdown).toContain("### Message delivery failed");
    expect(markdown).toContain("Junior could not deliver this message.");
    expect(markdown).not.toContain("turn-1");
    expect(markdown).not.toContain("Model connection failed");
    expect(markdown).not.toContain("Internal error");
  });

  it("labels redacted in-progress tools without inventing a completion", () => {
    const markdown = buildConversationMarkdown(
      conversation(
        [
          event(0, {
            type: "tool_calls",
            calls: [
              {
                toolCallId: "search-1",
                name: "search",
                status: "running",
              },
            ],
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

  it("exports structured-event content with a fence that survives nested backticks", () => {
    const agentsBody = [
      "# Agent Instructions",
      "",
      "Use this example:",
      "",
      "```ts",
      "console.log('hi')",
      "```",
    ].join("\n");
    const markdown = buildConversationMarkdown(
      conversation([
        event(0, {
          type: "structured_event",
          namespace: "junior",
          name: "agents_instructions_updated",
          version: 1,
          presentation: {
            icon: "brain",
            title: "Loaded AGENTS.md",
            preview: "AGENTS.md · 2 KB",
            details: [
              {
                title: "AGENTS.md",
                content: agentsBody,
              },
            ],
          },
        }),
      ]),
    );

    expect(markdown).toContain("### Loaded AGENTS.md");
    expect(markdown).toContain("- AGENTS.md");
    expect(markdown).toContain("````md\n" + agentsBody + "\n````");
  });
});
