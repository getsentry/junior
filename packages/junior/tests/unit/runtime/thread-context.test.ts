import { describe, expect, it } from "vitest";
import { Message } from "chat";
import {
  getAssistantThreadContext,
  getTeamId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

function slackMessage(args: {
  raw?: Record<string, unknown>;
  threadId?: string;
}): Message {
  return new Message({
    id: "test-message",
    threadId: args.threadId ?? "",
    text: "",
    isMention: false,
    attachments: [],
    metadata: { dateSent: new Date(0), edited: false },
    formatted: { type: "root", children: [] },
    raw: args.raw,
    author: {
      userId: "U_TEST",
      userName: "test-user",
      fullName: "Test User",
      isBot: false,
      isMe: false,
    },
  });
}

describe("stripLeadingBotMention", () => {
  it("strips the Slack adapter's normalized bot user id mention", () => {
    expect(
      stripLeadingBotMention("@U_BOT start the incident summary", {
        botUserId: "U_BOT",
        stripLeadingSlackMentionToken: true,
      }),
    ).toBe("start the incident summary");
  });

  it("keeps non-bot normalized mentions intact", () => {
    expect(
      stripLeadingBotMention("@U_OTHER ask junior for help", {
        botUserId: "U_BOT",
        stripLeadingSlackMentionToken: true,
      }),
    ).toBe("@U_OTHER ask junior for help");
  });

  it("preserves a referenced user after the leading bot mention", () => {
    expect(
      stripLeadingBotMention("<@U_BOT> <@U_OTHER> status?", {
        botUserId: "U_BOT",
        stripLeadingSlackMentionToken: true,
      }),
    ).toBe("<@U_OTHER> status?");
  });
});

describe("getAssistantThreadContext", () => {
  it("uses the current raw message ts for the first non-DM thread reply", () => {
    expect(
      getAssistantThreadContext(
        slackMessage({
          raw: {
            channel: "C12345",
            ts: "1700000000.200",
          },
        }),
      ),
    ).toEqual({
      channelId: "C12345",
      threadTs: "1700000000.200",
    });
  });

  it("uses the current raw thread_ts when Slack provides it", () => {
    expect(
      getAssistantThreadContext(
        slackMessage({
          raw: {
            channel: "D12345",
            thread_ts: "1700000000.100",
            ts: "1700000000.200",
          },
        }),
      ),
    ).toEqual({
      channelId: "D12345",
      threadTs: "1700000000.100",
    });
  });

  it("does not synthesize assistant thread_ts from the message ts", () => {
    expect(
      getAssistantThreadContext(
        slackMessage({
          raw: {
            channel: "D12345",
            ts: "1700000000.200",
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("falls back to the live non-DM thread id when raw event fields are absent", () => {
    expect(
      getAssistantThreadContext(
        slackMessage({
          threadId: "slack:C12345:1700000000.300",
        }),
      ),
    ).toEqual({
      channelId: "C12345",
      threadTs: "1700000000.300",
    });
  });

  it("does not fall back to a DM thread id without an explicit raw thread_ts", () => {
    expect(
      getAssistantThreadContext(
        slackMessage({
          threadId: "slack:D12345:1700000000.300",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("getTeamId", () => {
  it("uses the raw Slack workspace team when Slack provides it", () => {
    expect(
      getTeamId(
        slackMessage({
          raw: {
            team_id: "TRAW",
          },
        }),
      ),
    ).toBe("TRAW");
  });

  it("falls back to the inbound webhook workspace team", async () => {
    await runWithWorkspaceTeamId("TWORKSPACE", async () => {
      await Promise.resolve();
      expect(
        getTeamId(
          slackMessage({
            raw: {
              channel: "C12345",
              ts: "1700000000.200",
            },
          }),
        ),
      ).toBe("TWORKSPACE");
    });
  });

  it("prefers the inbound workspace over a Slack Connect author team", () => {
    runWithWorkspaceTeamId("TWORKSPACE", () => {
      expect(
        getTeamId(
          slackMessage({
            raw: {
              user_team: "TEXTERNAL",
            },
          }),
        ),
      ).toBe("TWORKSPACE");
    });
  });

  it("ignores non-team raw team values from DM payloads", () => {
    runWithWorkspaceTeamId("TWORKSPACE", () => {
      expect(
        getTeamId(
          slackMessage({
            raw: {
              channel: "D12345",
              team: "D12345",
            },
          }),
        ),
      ).toBe("TWORKSPACE");
    });
  });
});
