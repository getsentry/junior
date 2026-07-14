import { describe, expect, it } from "vitest";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { ConversationSubagentTranscriptReport } from "@sentry/junior/api/schema";

import {
  buildConversationMarkdown,
  buildSubagentMarkdown,
} from "../src/client/markdownExport";
import { subagentConversationTranscript } from "../src/client/subagentTranscript";
import type { Conversation } from "../src/client/types";

describe("dashboard markdown export", () => {
  it("serializes child-agent transcripts with shared formatting", () => {
    const report = {
      type: "subagent",
      createdAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:02.000Z",
      id: "advisor-call",
      outcome: "success",
      status: "success",
      subagentConversationId: "junior:conversation-1:advisor_session",
      subagentKind: "advisor",
      subagentSentryConversationUrl:
        "https://sentry.example/explore/conversations/advisor",
      transcript: [
        {
          role: "user",
          timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
          parts: [{ type: "text", text: "Review the implementation." }],
        },
        {
          role: "assistant",
          timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
          parts: [{ type: "text", text: "The implementation is sound." }],
        },
      ],
      transcriptAvailable: true,
    } satisfies ConversationSubagentTranscriptReport;
    const turn = subagentConversationTranscript("conversation-1", report);

    const markdown = buildSubagentMarkdown(report, turn);

    expect(markdown).toContain("# advisor");
    expect(markdown).toContain("- Subagent ID: `advisor-call`");
    expect(markdown).toContain(
      "- Conversation ID: junior:conversation-1:advisor_session",
    );
    expect(markdown).toContain("- Duration: 2.0s");
    expect(markdown).toContain("### User");
    expect(markdown).toContain("Review the implementation.");
    expect(markdown).toContain("### advisor");
    expect(markdown).toContain("The implementation is sound.");
  });

  it("serializes visible conversation transcripts as Markdown", () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    const detail = {
      conversationId: "slack:C1:222",
      cumulativeDurationMs: 0,
      displayTitle: "Copy button discussion",
      generatedAt: "2026-01-01T00:00:08.000Z",
      channel: "C1",
      channelName: "eng",
      lastProgressAt: "2026-01-01T00:00:07.000Z",
      lastSeenAt: "2026-01-01T00:00:07.000Z",
      actorIdentity: { fullName: "Alice" },
      startedAt,
      status: "completed",
      surface: "slack",
      contextEvents: [
        {
          type: "context_compacted",
          createdAt: "2026-01-01T00:00:01.500Z",
          modelId: "openai/gpt-5.4",
          summary: "Earlier investigation was summarized.",
          transcriptIndex: 1,
        },
        {
          type: "model_handoff",
          createdAt: "2026-01-01T00:00:04.000Z",
          fromModelId: "openai/gpt-5.4",
          toModelId: "openai/gpt-5.6-sol",
          message: "Continue with the implementation evidence.",
          transcriptIndex: 3,
        },
      ],
      transcriptAvailable: true,
      transcript: [
        {
          role: "user",
          timestamp: Date.parse(startedAt) + 1_000,
          parts: [
            {
              type: "text",
              text: "  copy this conversation  \n",
            },
          ],
        },
        {
          role: "assistant",
          timestamp: Date.parse(startedAt) + 2_000,
          parts: [
            {
              type: "thinking",
              output: "Need a deterministic export.  \n",
            },
            {
              type: "tool_call",
              id: "call-1",
              name: "search",
              input: { query: "copy markdown" },
            },
          ],
        },
        {
          role: "toolResult",
          timestamp: Date.parse(startedAt) + 3_500,
          parts: [
            {
              type: "tool_result",
              id: "call-1",
              name: "search",
              output: { ok: true },
            },
          ],
        },
        {
          role: "assistant",
          timestamp: Date.parse(startedAt) + 5_000,
          parts: [
            {
              type: "text",
              text: "## Done\n\n\n\nCopied as Markdown.",
            },
          ],
        },
      ],
    } satisfies ConversationDetailReport;

    const markdown = buildConversationMarkdown(detail);

    expect(markdown).toContain("# Copy button discussion");
    expect(markdown).toContain("- Conversation ID: `slack:C1:222`");
    expect(markdown).toContain("- Actor: Alice");
    expect(markdown).toContain("- Location: #eng (C1)");
    expect(markdown).toContain("## Transcript");
    expect(markdown).toContain("### Context compacted");
    expect(markdown).toContain("- Model: openai/gpt-5.4");
    expect(markdown).toContain("Earlier investigation was summarized.");
    expect(markdown).toContain("### Model handoff");
    expect(markdown).toContain("- From model: openai/gpt-5.4");
    expect(markdown).toContain("- To model: openai/gpt-5.6-sol");
    expect(markdown).toContain("Continue with the implementation evidence.");
    expect(markdown.indexOf("### Context compacted")).toBeLessThan(
      markdown.indexOf("### Model handoff"),
    );
    expect(markdown).not.toContain("## Turn");
    expect(markdown).not.toContain("- Turns:");
    expect(markdown).not.toContain("- Turn ID:");
    expect(markdown).toContain("### Alice");
    expect(markdown).toContain("  copy this conversation  \n");
    expect(markdown).toContain("### Thinking");
    expect(markdown).toContain("Need a deterministic export.  \n");
    expect(markdown).toContain("### Tool: search");
    expect(markdown).toContain('"query": "copy markdown"');
    expect(markdown).toContain("## Done\n\n\n\nCopied as Markdown.");
  });

  it("exports terminal assistant outcomes with safe copy", () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    const detail = {
      conversationId: "slack:C1:failed",
      cumulativeDurationMs: 0,
      displayTitle: "Failed responses",
      generatedAt: "2026-01-01T00:00:03.000Z",
      lastProgressAt: "2026-01-01T00:00:02.000Z",
      lastSeenAt: "2026-01-01T00:00:02.000Z",
      startedAt,
      status: "completed",
      surface: "slack",
      transcriptAvailable: true,
      transcript: [
        {
          role: "assistant",
          outcome: "error",
          timestamp: Date.parse(startedAt) + 1_000,
          parts: [],
        },
        {
          role: "assistant",
          outcome: "aborted",
          timestamp: Date.parse(startedAt) + 2_000,
          parts: [],
        },
      ],
    } satisfies ConversationDetailReport;

    const markdown = buildConversationMarkdown(detail);

    expect(markdown).toContain("### Agent response failed");
    expect(markdown).toContain(
      "The model response ended before Junior could complete this turn.",
    );
    expect(markdown).toContain("### Agent response stopped");
    expect(markdown).toContain(
      "The model response was stopped before Junior could complete this turn.",
    );
  });

  it("prefers the freshly loaded detail title over a stale list row title", () => {
    const generatedAt = "2026-01-01T00:00:08.000Z";
    const detail = {
      conversationId: "slack:C1:222",
      cumulativeDurationMs: 0,
      displayTitle: "Fresh async title",
      generatedAt,
      lastProgressAt: generatedAt,
      lastSeenAt: generatedAt,
      startedAt: generatedAt,
      status: "completed",
      surface: "slack",
      transcript: [],
      transcriptAvailable: false,
    } satisfies ConversationDetailReport;
    const conversation = {
      channel: "C1",
      channelName: "eng",
      cumulativeDurationMs: 0,
      displayTitle: "Public Channel",
      id: "slack:C1:222",
      lastProgressAt: generatedAt,
      lastSeenAt: generatedAt,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
    } satisfies Conversation;

    const markdown = buildConversationMarkdown(detail, conversation);

    expect(markdown).toContain("# Fresh async title");
    expect(markdown).not.toContain("# Public Channel");
  });

  it("exports running tool and subagent activity from derived transcript rows", () => {
    const detail = {
      conversationId: "conversation-activity",
      displayTitle: "Activity transcript",
      generatedAt: "2026-01-01T00:00:08.000Z",
      cumulativeDurationMs: 0,
      lastProgressAt: "2026-01-01T00:00:02.000Z",
      lastSeenAt: "2026-01-01T00:00:02.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      surface: "internal",
      transcriptAvailable: true,
      transcript: [],
      activity: [
        {
          type: "tool_execution",
          id: "advisor-call",
          toolCallId: "advisor-call",
          toolName: "advisor",
          createdAt: "2026-01-01T00:00:01.000Z",
          status: "running",
          subagents: [
            {
              type: "subagent",
              id: "advisor-call",
              subagentKind: "advisor",
              parentToolCallId: "advisor-call",
              createdAt: "2026-01-01T00:00:02.000Z",
              status: "running",
            },
          ],
        },
      ],
    } satisfies ConversationDetailReport;

    const markdown = buildConversationMarkdown(detail);

    expect(markdown).toContain("### Tool: advisor");
    expect(markdown).toContain("- Result: running");
    expect(markdown).toContain("### Subagent: advisor");
    expect(markdown).toContain("- Status: running");
    expect(markdown).toContain("- Parent tool call: advisor-call");
  });

  it("exports only safe redaction metadata for private transcripts", () => {
    const detail = {
      conversationId: "slack:D1:222",
      displayTitle: "Direct Message",
      generatedAt: "2026-01-01T00:00:08.000Z",
      channel: "D1",
      channelName: "Direct Message",
      cumulativeDurationMs: 7_000,
      lastProgressAt: "2026-01-01T00:00:07.000Z",
      lastSeenAt: "2026-01-01T00:00:07.000Z",
      actorIdentity: { email: "alice@example.com" },
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      surface: "slack",
      transcriptAvailable: false,
      transcriptRedacted: true,
      transcriptRedactionReason: "non_public_conversation",
      transcript: [],
      transcriptMetadata: [
        {
          role: "user",
          timestamp: 1_767_225_601_000,
          parts: [
            {
              bytes: 24,
              chars: 24,
              redacted: true,
              text: "private question",
              type: "text",
            },
          ],
        },
        {
          role: "assistant",
          timestamp: 1_767_225_602_000,
          parts: [
            {
              bytes: 22,
              chars: 22,
              redacted: true,
              text: "private answer",
              type: "text",
            },
            {
              id: "call-1",
              input: { query: "private search value" },
              inputKeys: ["query"],
              inputSizeBytes: 42,
              inputType: "object",
              name: "search",
              redacted: true,
              type: "tool_call",
            },
          ],
        },
        {
          role: "toolResult",
          timestamp: 1_767_225_603_000,
          parts: [
            {
              id: "call-1",
              name: "search",
              output: "private tool result",
              outputSizeBytes: 19,
              outputType: "string",
              redacted: true,
              type: "tool_result",
            },
          ],
        },
      ],
    } satisfies ConversationDetailReport;

    const markdown = buildConversationMarkdown(detail);

    expect(markdown).toContain("# Direct Message");
    expect(markdown).not.toContain("## Turn");
    expect(markdown).not.toContain("- Turn ID:");
    expect(markdown).toContain(
      "Transcript hidden because this conversation is not public.",
    );
    expect(markdown).toContain("<redacted> - 24 chars - 24 bytes");
    expect(markdown).toContain("<redacted> - 22 chars - 22 bytes");
    expect(markdown).toContain(
      "<redacted> - tool_call - name: `search` - input: object - input keys: query",
    );
    expect(markdown).toContain(
      "<redacted> - tool_result - name: `search` - output: string",
    );
    expect(markdown).not.toContain("private question");
    expect(markdown).not.toContain("private answer");
    expect(markdown).not.toContain("private search value");
    expect(markdown).not.toContain("private tool result");
  });
});
