import { describe, expect, it } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import {
  groupTranscriptMessages,
  messageRawText,
} from "../src/client/components/transcriptRenderModel";
import { entryMatchesSearch } from "../src/client/components/transcriptSearch";
import { conversationTranscriptMessages } from "../src/client/conversations/eventTranscript";
import { buildConversationMarkdown } from "../src/client/markdownExport";
import type { ConversationTranscript } from "../src/client/types";

function pluginEvent(
  data: ConversationReportEventData,
): ConversationReportEvent {
  return {
    seq: 1,
    createdAt: "2026-01-01T00:00:01.000Z",
    data,
  };
}

function conversation(
  events: ConversationReportEvent[],
): ConversationTranscript {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 0,
    displayTitle: "Conversation",
    eventHistory: { status: "available" },
    events,
    generatedAt: "2026-01-01T00:01:00.000Z",
    isParticipant: false,
    lastProgressAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    surface: "internal",
  };
}

describe("plugin event transcript projection", () => {
  it("creates a searchable standalone event entry", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        pluginEvent({
          type: "plugin_event",
          namespace: "memory",
          name: "memories_captured",
          version: 1,
          turnId: "turn-1",
          presentation: {
            icon: "brain",
            title: "Memories captured",
            preview: "2 memories",
            details: [
              {
                title: "Use pnpm.",
                metadata: ["preference", "personal"],
              },
            ],
          },
        }),
      ]),
    );
    const entries = groupTranscriptMessages(messages);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: "plugin_event",
        part: expect.objectContaining({
          namespace: "memory",
          name: "memories_captured",
        }),
      }),
    ]);
    expect(entryMatchesSearch(entries[0]!, "pnpm")).toBe(true);
    expect(messageRawText(messages[0]!)).toContain("Use pnpm.");
  });

  it("includes shared event timestamp and offset metadata in Markdown", () => {
    const markdown = buildConversationMarkdown(
      conversation([
        pluginEvent({
          type: "plugin_event",
          namespace: "memory",
          name: "memories_captured",
          version: 1,
          turnId: "turn-1",
          presentation: {
            title: "Memory captured",
            preview: "Use pnpm.",
          },
        }),
      ]),
    );

    expect(markdown).toContain("### Memory captured");
    expect(markdown).toContain("2026-01-01T00:00:01.000Z - +1.0s");
  });
});
