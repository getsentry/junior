import { describe, expect, it } from "vitest";
import type {
  ConversationReportEvent,
  ConversationReportEventData,
} from "@sentry/junior/api/schema";

import {
  groupTranscriptMessages,
  messageRawText,
} from "../src/client/conversations/transcriptRenderModel";
import { entryMatchesSearch } from "../src/client/conversations/transcriptSearch";
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
          type: "structured_event",
          namespace: "memory",
          name: "memories_captured",
          version: 1,
          turnId: "turn-1",
          presentation: {
            icon: "brain",
            title: "2 memories captured",
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
        kind: "structured_event",
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
          type: "structured_event",
          namespace: "memory",
          name: "memories_captured",
          version: 1,
          turnId: "turn-1",
          presentation: {
            title: "1 memory captured",
          },
        }),
      ]),
    );

    expect(markdown).toContain("### 1 memory captured");
    expect(markdown).toContain("2026-01-01T00:00:01.000Z - +1.0s");
  });

  it("creates a searchable standalone native authentication event entry", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        pluginEvent({
          type: "structured_event",
          namespace: "junior",
          name: "authentication_linked",
          version: 1,
          turnId: "turn-1",
          presentation: {
            icon: "link",
            title: "GitHub connected",
            preview: "Connected as `dcramer`",
          },
        }),
      ]),
    );
    const entries = groupTranscriptMessages(messages);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: "structured_event",
        part: expect.objectContaining({
          namespace: "junior",
          name: "authentication_linked",
        }),
      }),
    ]);
    expect(entryMatchesSearch(entries[0]!, "dcramer")).toBe(true);
    expect(messageRawText(messages[0]!)).toContain("GitHub connected");
  });

  it("creates a searchable AGENTS.md load event entry", () => {
    const messages = conversationTranscriptMessages(
      conversation([
        pluginEvent({
          type: "structured_event",
          namespace: "junior",
          name: "agents_instructions_updated",
          version: 1,
          turnId: "turn-1",
          presentation: {
            icon: "brain",
            title: "Loaded AGENTS.md",
            preview: "AGENTS.md · 2 KB",
            details: [
              {
                title: "AGENTS.md",
                content: "# Agent Instructions\n\nUse pnpm.",
              },
            ],
          },
        }),
      ]),
    );
    const entries = groupTranscriptMessages(messages);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: "structured_event",
        part: expect.objectContaining({
          namespace: "junior",
          name: "agents_instructions_updated",
        }),
      }),
    ]);
    expect(entryMatchesSearch(entries[0]!, "use pnpm")).toBe(true);
    expect(messageRawText(messages[0]!)).toContain("Loaded AGENTS.md");
    expect(messageRawText(messages[0]!)).toContain("Use pnpm.");
  });
});
