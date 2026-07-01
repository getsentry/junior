import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptSearchTool } from "@/chat/tools/transcripts/search";
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
      const searched = parseContent(
        await executeTool(
          createTranscriptSearchTool(context, { conversationStore: store }),
          { include_links: false, limit: 10, query: "visibility note" },
        ),
      );

      expect(
        searched.matches.map((entry: any) => entry.conversation_id),
      ).toEqual(["slack:GSOURCE:1700000000.000001"]);
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
