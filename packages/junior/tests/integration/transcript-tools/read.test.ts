import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptReadTool } from "@/chat/tools/transcripts/read";
import {
  TRANSCRIPT_UNAVAILABLE_ERROR,
  closeFixture,
  compaction,
  executeTool,
  localContext,
  message,
  parseContent,
  recordLocalTranscript,
  recordSlackTranscript,
  resetTranscriptTestState,
  setupFixture,
  slackContext,
} from "./fixtures";

describe("transcriptRead", () => {
  afterEach(resetTranscriptTestState);

  it("reads one accessible transcript and rejects unrelated private transcripts", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordSlackTranscript({
        store,
        channelId: "GPRIVATE",
        conversationId: "slack:GPRIVATE:1700000000.000002",
        title: "Current private thread",
        messages: [
          message("private-1", "first visible private message"),
          message("private-2", "second visible private message", {
            role: "assistant",
          }),
        ],
      });
      await recordSlackTranscript({
        store,
        channelId: "GOTHER",
        conversationId: "slack:GOTHER:1700000000.000003",
        title: "Other private thread",
        messages: [message("other-1", "hidden private message")],
      });

      const tool = createTranscriptReadTool(slackContext(), {
        conversationStore: store,
      });
      const allowed = parseContent(
        await executeTool(tool, {
          conversation_id: "slack:GPRIVATE:1700000000.000002",
          include_links: false,
        }),
      );
      const blocked = await executeTool(tool, {
        conversation_id: "slack:GOTHER:1700000000.000003",
        include_links: false,
      });
      const missing = await executeTool(tool, {
        conversation_id: "slack:GUNKNOWN:1700000000.000004",
        include_links: false,
      });

      expect(allowed).toMatchObject({
        ok: true,
        conversation_id: "slack:GPRIVATE:1700000000.000002",
        count: 2,
      });
      expect(allowed.messages.map((entry: any) => entry.text)).toEqual([
        "first visible private message",
        "second visible private message",
      ]);
      expect(blocked).toEqual({
        ok: false,
        error: TRANSCRIPT_UNAVAILABLE_ERROR,
      });
      expect(missing).toEqual(blocked);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("uses Slack source channel, not destination channel, for private access", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordSlackTranscript({
        store,
        channelId: "GSOURCE",
        conversationId: "slack:GSOURCE:1700000000.000001",
        title: "Source private thread",
        messages: [message("source-1", "source visibility note")],
      });
      await recordSlackTranscript({
        store,
        channelId: "GDEST",
        conversationId: "slack:GDEST:1700000000.000002",
        title: "Destination private thread",
        messages: [message("dest-1", "destination visibility note")],
      });

      const context = slackContext({
        sourceChannelId: "GSOURCE",
        destinationChannelId: "GDEST",
      });
      const tool = createTranscriptReadTool(context, {
        conversationStore: store,
      });
      const allowed = parseContent(
        await executeTool(tool, {
          conversation_id: "slack:GSOURCE:1700000000.000001",
          include_links: false,
        }),
      );
      const blocked = await executeTool(tool, {
        conversation_id: "slack:GDEST:1700000000.000002",
        include_links: false,
      });

      expect(allowed).toMatchObject({
        ok: true,
        conversation_id: "slack:GSOURCE:1700000000.000001",
      });
      expect(blocked).toEqual({
        ok: false,
        error: TRANSCRIPT_UNAVAILABLE_ERROR,
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("reads retained compaction summaries", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordSlackTranscript({
        store,
        channelId: "CPUBLIC",
        compactions: [
          compaction(
            "compaction-1",
            "Older retained context about budget invoice routing",
            ["old-1", "old-2", "old-3"],
          ),
        ],
        conversationId: "slack:CPUBLIC:1700000000.000001",
        title: "Public compacted thread",
        messages: [message("public-1", "new visible transcript")],
      });

      const read = parseContent(
        await executeTool(
          createTranscriptReadTool(slackContext(), {
            conversationStore: store,
          }),
          {
            conversation_id: "slack:CPUBLIC:1700000000.000001",
            include_links: false,
          },
        ),
      );

      expect(read).toMatchObject({
        ok: true,
        conversation_id: "slack:CPUBLIC:1700000000.000001",
        compaction_count: 1,
        live_message_count: 1,
        total_message_count: 4,
      });
      expect(read.compactions[0]).toMatchObject({
        id: "compaction-1",
        summary: "Older retained context about budget invoice routing",
        covered_message_count: 3,
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("reads only the current local source transcript", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordLocalTranscript({
        store,
        conversationId: "local:test:current",
        title: "Current local run",
        messages: [message("local-1", "local visible transcript")],
      });
      await recordLocalTranscript({
        store,
        conversationId: "local:test:other",
        title: "Other local run",
        messages: [message("local-2", "local hidden transcript")],
      });

      const tool = createTranscriptReadTool(
        localContext("local:test:current"),
        {
          conversationStore: store,
        },
      );
      const allowed = parseContent(
        await executeTool(tool, {
          conversation_id: "local:test:current",
          include_links: false,
        }),
      );
      const blocked = await executeTool(tool, {
        conversation_id: "local:test:other",
        include_links: false,
      });

      expect(allowed).toMatchObject({
        ok: true,
        conversation_id: "local:test:current",
        count: 1,
      });
      expect(blocked).toEqual({
        ok: false,
        error: TRANSCRIPT_UNAVAILABLE_ERROR,
      });
    } finally {
      await closeFixture(fixture);
    }
  });
});
