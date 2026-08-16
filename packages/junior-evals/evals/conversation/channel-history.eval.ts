import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { getConversationStore } from "@/chat/db";
import { mention, rubric, slackEvals } from "../../src/helpers";

const knownChannel = {
  id: "C0RELEASEUPDATES",
  name: "release-updates",
};

describeEval("Slack Channel History", slackEvals, (it) => {
  it("when a teammate names a known channel, report its latest update", async ({
    run,
  }) => {
    await getConversationStore().recordActivity({
      conversationId: `slack:${knownChannel.id}:17000000.740001`,
      channelName: knownChannel.name,
      destination: {
        platform: "slack",
        teamId: "TEVAL",
        channelId: knownChannel.id,
      },
      nowMs: Date.parse("2026-08-16T00:00:00.000Z"),
      source: "slack",
      visibility: "public",
    });

    const result = await run({
      initialEvents: [
        mention("what's the latest update in #release-updates?"),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant checks the named Slack channel and reports the latest available message.",
        ],
        fail: [
          "Do not claim the channel is unknown or ask for its id, link, or a native Slack mention.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toContainEqual(
      expect.objectContaining({
        name: "slackChannelListMessages",
        status: "ok",
      }),
    );
  });
});
