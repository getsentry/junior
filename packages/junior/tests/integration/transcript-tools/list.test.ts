import { afterEach, describe, expect, it } from "vitest";
import { createTranscriptListTool } from "@/chat/tools/transcripts/transcript-list";
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

describe("transcriptList", () => {
  afterEach(resetTranscriptTestState);

  it("lists public transcripts and same-context private transcripts only", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordSlackTranscript({
        store,
        channelId: "CPUBLIC",
        conversationId: "slack:CPUBLIC:1700000000.000001",
        title: "Public thread",
        messages: [message("public-1", "public transcript")],
      });
      await recordSlackTranscript({
        store,
        channelId: "GPRIVATE",
        conversationId: "slack:GPRIVATE:1700000000.000002",
        title: "Current private thread",
        messages: [message("private-1", "current private transcript")],
      });
      await recordSlackTranscript({
        store,
        channelId: "GOTHER",
        conversationId: "slack:GOTHER:1700000000.000003",
        title: "Other private thread",
        messages: [message("other-1", "other private transcript")],
      });
      await recordSlackTranscript({
        store,
        channelId: "COTHERTEAM",
        conversationId: "slack:COTHERTEAM:1700000000.000004",
        teamId: "TOTHER",
        title: "Other workspace thread",
        messages: [message("team-1", "other workspace transcript")],
      });

      const result = await executeTool(
        createTranscriptListTool(slackContext(), { conversationStore: store }),
        { include_links: false, limit: 10 },
      );
      const body = parseContent(result);
      const conversationIds = body.transcripts.map(
        (entry: any) => entry.conversation_id,
      );

      expect(conversationIds).toEqual(
        expect.arrayContaining([
          "slack:CPUBLIC:1700000000.000001",
          "slack:GPRIVATE:1700000000.000002",
        ]),
      );
      expect(conversationIds).not.toEqual(
        expect.arrayContaining([
          "slack:GOTHER:1700000000.000003",
          "slack:COTHERTEAM:1700000000.000004",
        ]),
      );
    } finally {
      await closeFixture(fixture);
    }
  });

  it("limits visible list results without exposing raw scan metadata", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordSlackTranscript({
        store,
        channelId: "CPUBLIC",
        conversationId: "slack:CPUBLIC:1700000000.000001",
        title: "Public thread 1",
        messages: [message("public-1", "public transcript 1")],
      });
      await recordSlackTranscript({
        store,
        channelId: "CPUBLIC",
        conversationId: "slack:CPUBLIC:1700000000.000002",
        title: "Public thread 2",
        messages: [message("public-2", "public transcript 2")],
      });
      await recordSlackTranscript({
        store,
        channelId: "CPUBLIC",
        conversationId: "slack:CPUBLIC:1700000000.000003",
        title: "Public thread 3",
        messages: [message("public-3", "public transcript 3")],
      });

      const result = await executeTool(
        createTranscriptListTool(slackContext(), { conversationStore: store }),
        { include_links: false, limit: 1 },
      );
      const body = parseContent(result);

      expect(body.count).toBe(1);
      expect(body).not.toHaveProperty("scanned_conversation_count");
      expect(body).not.toHaveProperty("next_offset");
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
      const listed = parseContent(
        await executeTool(
          createTranscriptListTool(context, { conversationStore: store }),
          { include_links: false, limit: 10 },
        ),
      );

      const conversationIds = listed.transcripts
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
          messages: [],
        });
      }
      await recordSlackTranscript({
        store,
        channelId: "GPRIVATE",
        conversationId: "slack:GPRIVATE:1700000000.999999",
        lastActivityAtMs: baseMs,
        title: "Older visible private thread",
        messages: [message("visible-1", "older visible transcript")],
      });

      const listed = parseContent(
        await executeTool(
          createTranscriptListTool(slackContext(), {
            conversationStore: store,
          }),
          { include_links: false, limit: 1 },
        ),
      );

      expect(listed.transcripts).toHaveLength(1);
      expect(listed.transcripts[0]).toMatchObject({
        conversation_id: "slack:GPRIVATE:1700000000.999999",
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("includes best-effort source links by default", async () => {
    const { fixture, store } = await setupFixture();
    try {
      await recordSlackTranscript({
        store,
        channelId: "CPUBLIC",
        conversationId: "slack:CPUBLIC:1700000000.000001",
        title: "Public linked thread",
        messages: [message("public-1", "public linked transcript")],
      });
      const linkCalls: Array<{ channelId: string; messageTs: string }> = [];

      const result = await executeTool(
        createTranscriptListTool(slackContext(), {
          conversationStore: store,
          getSlackLink: async (args) => {
            linkCalls.push(args);
            return `https://example.invalid/${args.channelId}/${args.messageTs}`;
          },
        }),
        { limit: 10 },
      );
      const body = parseContent(result);

      expect(body.transcripts[0]).toMatchObject({
        conversation_id: "slack:CPUBLIC:1700000000.000001",
        link: "https://example.invalid/CPUBLIC/1700000000.000001",
      });
      expect(linkCalls).toEqual([
        { channelId: "CPUBLIC", messageTs: "1700000000.000001" },
      ]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("includes retained compaction counts", async () => {
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

      const listed = parseContent(
        await executeTool(
          createTranscriptListTool(slackContext(), {
            conversationStore: store,
          }),
          { include_links: false, limit: 10 },
        ),
      );

      expect(listed.transcripts[0]).toMatchObject({
        conversation_id: "slack:CPUBLIC:1700000000.000001",
        compaction_count: 1,
        message_count: 1,
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("lists only the current local source transcript", async () => {
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

      const listed = parseContent(
        await executeTool(
          createTranscriptListTool(localContext("local:test:current"), {
            conversationStore: store,
          }),
          { include_links: false, limit: 10 },
        ),
      );

      expect(
        listed.transcripts.map((entry: any) => entry.conversation_id),
      ).toEqual(["local:test:current"]);
    } finally {
      await closeFixture(fixture);
    }
  });
});
