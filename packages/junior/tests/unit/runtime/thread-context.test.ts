import { describe, expect, it } from "vitest";
import { getAssistantThreadContext } from "@/chat/runtime/thread-context";

describe("getAssistantThreadContext", () => {
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
});
