import { describe, expect, it } from "vitest";
import {
  getAssistantThreadContext,
  getTeamId,
} from "@/chat/runtime/thread-context";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

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

describe("getTeamId", () => {
  it("uses the raw Slack workspace team when Slack provides it", () => {
    expect(
      getTeamId({
        raw: {
          team_id: "T_RAW",
        },
      } as any),
    ).toBe("T_RAW");
  });

  it("falls back to the inbound webhook workspace team", async () => {
    await runWithWorkspaceTeamId("T_WORKSPACE", async () => {
      await Promise.resolve();
      expect(
        getTeamId({
          raw: {
            channel: "C12345",
            ts: "1700000000.200",
          },
        } as any),
      ).toBe("T_WORKSPACE");
    });
  });

  it("prefers the inbound workspace over a Slack Connect author team", () => {
    runWithWorkspaceTeamId("T_WORKSPACE", () => {
      expect(
        getTeamId({
          raw: {
            user_team: "T_EXTERNAL",
          },
        } as any),
      ).toBe("T_WORKSPACE");
    });
  });
});
