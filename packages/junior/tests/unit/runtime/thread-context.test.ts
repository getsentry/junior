import { describe, expect, it } from "vitest";
import {
  getAssistantThreadContext,
  getMessageTs,
  getTeamId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

describe("stripLeadingBotMention", () => {
  it("strips the Slack adapter's normalized bot user id mention", () => {
    expect(
      stripLeadingBotMention("@U0BOT start the incident summary", {
        botUserId: "U0BOT",
        stripLeadingSlackMentionToken: true,
      }),
    ).toBe("start the incident summary");
  });

  it("keeps non-bot normalized mentions intact", () => {
    expect(
      stripLeadingBotMention("@U0OTHER ask junior for help", {
        botUserId: "U0BOT",
        stripLeadingSlackMentionToken: true,
      }),
    ).toBe("@U0OTHER ask junior for help");
  });

  it("preserves a referenced user after the leading bot mention", () => {
    expect(
      stripLeadingBotMention("<@U0BOT> <@U0OTHER> status?", {
        botUserId: "U0BOT",
        stripLeadingSlackMentionToken: true,
      }),
    ).toBe("<@U0OTHER> status?");
  });
});

describe("getAssistantThreadContext", () => {
  it("uses the current raw message ts for the first non-DM thread reply", () => {
    expect(
      getAssistantThreadContext({
        raw: {
          channel: "C12345",
          ts: "1700000000.200",
        },
      } as any),
    ).toEqual({
      channelId: "C12345",
      threadTs: "1700000000.200",
    });
  });

  it("uses the current raw thread_ts when Slack provides it", () => {
    expect(
      getAssistantThreadContext({
        raw: {
          channel: "D12345",
          thread_ts: "1700000000.100",
          ts: "1700000000.200",
        },
      } as any),
    ).toEqual({
      channelId: "D12345",
      threadTs: "1700000000.100",
    });
  });

  it("does not synthesize assistant thread_ts from the message ts", () => {
    expect(
      getAssistantThreadContext({
        raw: {
          channel: "D12345",
          ts: "1700000000.200",
        },
      } as any),
    ).toBeUndefined();
  });

  it("falls back to the live non-DM thread id when raw event fields are absent", () => {
    expect(
      getAssistantThreadContext({
        threadId: "slack:C12345:1700000000.300",
      } as any),
    ).toEqual({
      channelId: "C12345",
      threadTs: "1700000000.300",
    });
  });

  it("does not fall back to a DM thread id without an explicit raw thread_ts", () => {
    expect(
      getAssistantThreadContext({
        threadId: "slack:D12345:1700000000.300",
      } as any),
    ).toBeUndefined();
  });
});

describe("getMessageTs", () => {
  it("uses a direct normalized message timestamp first", () => {
    expect(
      getMessageTs({
        raw: {
          ts: "1700000000.100",
        },
        ts: "1700000000.200",
      } as any),
    ).toBe("1700000000.200");
  });

  it("uses the raw Slack message timestamp when direct ts is absent", () => {
    expect(
      getMessageTs({
        raw: {
          ts: "1700000000.300",
        },
      } as any),
    ).toBe("1700000000.300");
  });

  it("falls back to the nested Slack message timestamp", () => {
    expect(
      getMessageTs({
        raw: {
          message: {
            ts: "1700000000.400",
          },
        },
      } as any),
    ).toBe("1700000000.400");
  });
});

describe("getTeamId", () => {
  it("uses the raw Slack workspace team when Slack provides it", () => {
    expect(
      getTeamId({
        raw: {
          team_id: "TRAW",
        },
      } as any),
    ).toBe("TRAW");
  });

  it("falls back to the inbound webhook workspace team", async () => {
    await runWithWorkspaceTeamId("TWORKSPACE", async () => {
      await Promise.resolve();
      expect(
        getTeamId({
          raw: {
            channel: "C12345",
            ts: "1700000000.200",
          },
        } as any),
      ).toBe("TWORKSPACE");
    });
  });

  it("prefers the inbound workspace over a Slack Connect author team", () => {
    runWithWorkspaceTeamId("TWORKSPACE", () => {
      expect(
        getTeamId({
          raw: {
            user_team: "TEXTERNAL",
          },
        } as any),
      ).toBe("TWORKSPACE");
    });
  });

  it("ignores non-team raw team values from DM payloads", () => {
    runWithWorkspaceTeamId("TWORKSPACE", () => {
      expect(
        getTeamId({
          raw: {
            channel: "D12345",
            team: "D12345",
          },
        } as any),
      ).toBe("TWORKSPACE");
    });
  });
});
