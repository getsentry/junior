import { describe, expect, it } from "vitest";

import { buildConversationMarkdown } from "../src/client/markdownExport";
import type {
  ConversationDetailFeed,
  ConversationTurn,
} from "../src/client/types";

describe("dashboard markdown export", () => {
  it("serializes visible conversation transcripts as Markdown", () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    const detail = {
      conversationId: "slack:C1:222",
      generatedAt: "2026-01-01T00:00:08.000Z",
      turns: [
        {
          channel: "C1",
          channelName: "eng",
          conversationId: "slack:C1:222",
          conversationTitle: "Copy button discussion",
          id: "turn-1",
          lastProgressAt: "2026-01-01T00:00:07.000Z",
          lastSeenAt: "2026-01-01T00:00:07.000Z",
          requesterIdentity: { fullName: "Alice" },
          startedAt,
          status: "completed",
          surface: "slack",
          title: "Turn turn-1",
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
        } as ConversationTurn,
      ],
    } satisfies ConversationDetailFeed;

    const markdown = buildConversationMarkdown(detail);

    expect(markdown).toContain("# Copy button discussion");
    expect(markdown).toContain("- Conversation ID: `slack:C1:222`");
    expect(markdown).toContain("- Requester: Alice");
    expect(markdown).toContain("- Location: #eng (C1)");
    expect(markdown).toContain("## Transcript");
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

  it("exports only safe redaction metadata for private transcripts", () => {
    const detail = {
      conversationId: "slack:D1:222",
      generatedAt: "2026-01-01T00:00:08.000Z",
      turns: [
        {
          channel: "D1",
          channelName: "Direct Message",
          conversationId: "slack:D1:222",
          conversationTitle: "Direct Message",
          cumulativeDurationMs: 7_000,
          id: "turn-private",
          lastProgressAt: "2026-01-01T00:00:07.000Z",
          lastSeenAt: "2026-01-01T00:00:07.000Z",
          requesterIdentity: { email: "alice@example.com" },
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "completed",
          surface: "slack",
          title: "Direct Message",
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
        } as ConversationTurn,
      ],
    } satisfies ConversationDetailFeed;

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
