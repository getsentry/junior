import { describe, expect, it } from "vitest";
import { promptPlatform } from "@/chat/agent/prompt";

const slackRun = {
  delivery: async () => {},
  location: {
    id: "location-1",
    provider: "slack" as const,
    teamId: "T123",
    channelId: "C123",
    threadTs: "1712345.0001",
  },
};

describe("promptPlatform", () => {
  // A child's final text goes to its parent, so a Delivery and a Slack
  // Location do not give it the Slack prompt. A person's Turn keeps it.
  it("keeps a child Turn local when it has a Delivery and a Slack Location", () => {
    expect(promptPlatform(slackRun, "child_agent")).toBe("local");
    expect(promptPlatform(slackRun, "conversation")).toBe("slack");
  });
});
