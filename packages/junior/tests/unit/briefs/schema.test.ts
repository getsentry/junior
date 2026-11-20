import { describe, expect, it } from "vitest";
import { parseStoredBrief } from "@/chat/briefs/schema";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";

describe("parseStoredBrief", () => {
  it("drops open decisions from Briefs stored before their removal", () => {
    const brief = conversationBriefFixture();

    expect(
      parseStoredBrief({
        ...brief,
        openDecisions: [{ text: "Pick a rollout plan.", owner: "Test User" }],
      }),
    ).toEqual(brief);
  });
});
