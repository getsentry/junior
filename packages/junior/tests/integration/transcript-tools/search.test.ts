import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptSearchTool } from "@/chat/tools/transcripts/transcript-search";
import {
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

describe("transcriptSearch", () => {
  afterEach(resetTranscriptTestState);

  it("searches public and same-context private transcripts without leaking other private matches", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordSlackTranscript({
        store,
        channelId: "CPUBLIC",
        conversationId: "slack:CPUBLIC:1700000000.000001",
        title: "Public release",
        messages: [message("public-1", "shared deploy notes")],
      });
      await recordSlackTranscript({
        store,
        channelId: "GPRIVATE",
        conversationId: "slack:GPRIVATE:1700000000.000002",
        title: "Private incident",
        messages: [message("private-1", "shared incident notes")],
      });
      await recordSlackTranscript({
        store,
        channelId: "GOTHER",
        conversationId: "slack:GOTHER:1700000000.000003",
        title: "Other private incident",
        messages: [message("other-1", "shared secret incident notes")],
      });

      const result = await executeTool(
        createTranscriptSearchTool(slackContext(), {
          conversationStore: store,
        }),
        { query: "shared notes", include_links: false, limit: 10 },
      );
      const body = parseContent(result);
      const conversationIds = body.matches.map(
        (entry: any) => entry.conversation_id,
      );

      expect(conversationIds).toEqual(
        expect.arrayContaining([
          "slack:CPUBLIC:1700000000.000001",
          "slack:GPRIVATE:1700000000.000002",
        ]),
      );
      expect(conversationIds).not.toContain("slack:GOTHER:1700000000.000003");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("uses Slack source and destination channels for private access", async () => {
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
      const searched = parseContent(
        await executeTool(
          createTranscriptSearchTool(context, { conversationStore: store }),
          { include_links: false, limit: 10, query: "visibility note" },
        ),
      );

      const conversationIds = searched.matches
        .map((entry: any) => entry.conversation_id)
        .sort();
      expect(conversationIds).toEqual([
        "slack:GDEST:1700000000.000002",
        "slack:GSOURCE:1700000000.000001",
      ]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("continues scanning when inaccessible rows fill the first SQL page", async () => {
    const { fixture, store } = await setupFixture();
    try {
      const baseMs = Date.parse("2026-06-11T12:00:00.000Z");
      for (let index = 0; index < 101; index += 1) {
        await recordSlackTranscript({
          store,
          channelId: "GOTHER",
          conversationId: `slack:GOTHER:1700000000.${String(index).padStart(6, "0")}`,
          lastActivityAtMs: baseMs + 101 - index,
          title: `Other private thread ${index}`,
          messages: [message(`hidden-${index}`, "hidden keyword note")],
        });
      }
      await recordSlackTranscript({
        store,
        channelId: "GPRIVATE",
        conversationId: "slack:GPRIVATE:1700000000.999999",
        lastActivityAtMs: baseMs,
        title: "Older visible private thread",
        messages: [message("visible-1", "older visible keyword note")],
      });

      const searched = parseContent(
        await executeTool(
          createTranscriptSearchTool(slackContext(), {
            conversationStore: store,
          }),
          { include_links: false, limit: 1, query: "keyword" },
        ),
      );

      expect(searched.matches).toHaveLength(1);
      expect(searched.matches[0]).toMatchObject({
        conversation_id: "slack:GPRIVATE:1700000000.999999",
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("searches retained compaction summaries", async () => {
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

      const searched = parseContent(
        await executeTool(
          createTranscriptSearchTool(slackContext(), {
            conversationStore: store,
          }),
          { include_links: false, limit: 10, query: "budget invoice" },
        ),
      );

      expect(searched.matches[0]).toMatchObject({
        conversation_id: "slack:CPUBLIC:1700000000.000001",
        compaction: {
          id: "compaction-1",
          covered_message_count: 3,
        },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("searches only the current local source transcript", async () => {
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

      const searched = parseContent(
        await executeTool(
          createTranscriptSearchTool(localContext("local:test:current"), {
            conversationStore: store,
          }),
          { include_links: false, limit: 10, query: "local transcript" },
        ),
      );

      expect(
        searched.matches.map((entry: any) => entry.conversation_id),
      ).toEqual(["local:test:current"]);
    } finally {
      await closeFixture(fixture);
    }
  });
});
