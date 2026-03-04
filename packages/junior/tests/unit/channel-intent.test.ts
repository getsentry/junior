import { describe, expect, it } from "vitest";
import { isExplicitChannelPostIntent } from "@/chat/channel-intent";

describe("isExplicitChannelPostIntent", () => {
  it("detects classic in-channel post phrasing", () => {
    expect(isExplicitChannelPostIntent("send this update to the channel")).toBe(true);
  });

  it("detects show-the-channel phrasing", () => {
    expect(isExplicitChannelPostIntent("show the channel")).toBe(true);
    expect(isExplicitChannelPostIntent("show this in the channel")).toBe(true);
  });

  it("does not trigger for generic channel references", () => {
    expect(isExplicitChannelPostIntent("what happened in this channel yesterday?")).toBe(false);
  });
});
