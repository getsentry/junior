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

  // Every Turn of a Thread uses its Location's platform, also an agent's
  // Turn with no Delivery, so the Thread keeps one system prompt.
  it("gives every Turn of a Thread its Location's platform", () => {
    const { delivery: _delivery, ...agentRun } = slackRun;
    expect(promptPlatform(slackRun, "thread")).toBe("slack");
    expect(promptPlatform(agentRun, "thread")).toBe("slack");
    expect(promptPlatform({}, "thread")).toBe("local");
  });
});
