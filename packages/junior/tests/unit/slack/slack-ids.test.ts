import { describe, expect, it } from "vitest";
import {
  isSlackTeamId,
  parseSlackChannelId,
  parseSlackChannelReferenceId,
  parseSlackTeamId,
  parseSlackUserId,
} from "@/chat/slack/ids";

describe("slack ids", () => {
  it("parses exact Slack channel ids", () => {
    expect(parseSlackChannelId("C123")).toBe("C123");
    expect(parseSlackChannelId("G123")).toBe("G123");
    expect(parseSlackChannelId("D123")).toBe("D123");
    expect(parseSlackChannelId(" slack:C123:1700000000.100 ")).toBeUndefined();
    expect(parseSlackChannelId("X123")).toBeUndefined();
    expect(parseSlackChannelId("slack:")).toBeUndefined();
  });

  it("parses channel ids from Junior slack references", () => {
    expect(parseSlackChannelReferenceId("slack:C123")).toBe("C123");
    expect(parseSlackChannelReferenceId(" slack:C123:1700000000.100 ")).toBe(
      "C123",
    );
    expect(parseSlackChannelReferenceId("slack:C123:not-a-ts")).toBeUndefined();
  });

  it("parses Slack team and user ids", () => {
    expect(parseSlackTeamId(" T123 ")).toBe("T123");
    expect(parseSlackUserId(" U123 ")).toBe("U123");
    expect(parseSlackUserId("W123")).toBe("W123");
    expect(parseSlackTeamId("C123")).toBeUndefined();
    expect(parseSlackUserId("unknown")).toBeUndefined();
  });

  it("keeps exact guard behavior for persisted ids", () => {
    expect(isSlackTeamId("T123")).toBe(true);
    expect(isSlackTeamId(" T123 ")).toBe(false);
  });
});
