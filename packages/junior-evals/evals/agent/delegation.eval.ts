import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { mockWebSearchResults } from "@junior-evals/fixture/web";

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself.
describe("Implicit Delegation", () => {
  test("when a request splits into independent research tracks, start a child agent for each track", async ({
    agent,
  }) => {
    // A small budget keeps each child short. The case measures the parent's
    // choice to delegate, not the quality of the children's research.
    // The tracks use docs.slack.dev, an origin the recording proxy allows,
    // so the children's pages load and a passing run records them.
    mockWebSearchResults([
      {
        excerpt: "Receive events from Slack over HTTP request URLs.",
        title: "Using the Events API with HTTP request URLs",
        url: "https://docs.slack.dev/apis/events-api/using-http-request-urls",
      },
      {
        excerpt: "Receive events from Slack over a WebSocket connection.",
        title: "Using Socket Mode",
        url: "https://docs.slack.dev/apis/events-api/using-socket-mode",
      },
      {
        excerpt: "Respond to slash commands that users invoke in Slack.",
        title: "Implementing slash commands",
        url: "https://docs.slack.dev/interactivity/implementing-slash-commands",
      },
    ]);
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    const conversation = await run(
      slackMention(
        "I need to pick how a new service receives work from Slack. Research how Events API HTTP request URLs, Socket Mode, and slash commands each handle acknowledgement deadlines, retries, and delivery failures. Go to Slack's own docs for each, then give me the tradeoffs.",
      ),
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
  });

  test("when a request needs only a few direct tool calls, do the work without a child agent", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC and in Tokyo?"),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
  });
});
