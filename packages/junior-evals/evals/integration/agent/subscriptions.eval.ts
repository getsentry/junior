import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  githubWebhook,
  mention,
  rubric,
  slackEvals,
  visibleThreadReplies,
} from "../../../src/helpers";

describeEval("Resource Event Subscriptions", slackEvals, (it) => {
  it("when a follow-up stops monitoring, cancel the selected watch before confirming", async ({
    run,
  }) => {
    const thread = {
      id: "thread-resource-event-stop",
      channel_id: "CRESOURCEEVENTSTOP",
      thread_ts: "17000000.7301",
    };
    const result = await run({
      overrides: {
        github_resource_events: true,
        plugin_dirs: ["fixtures/resource-event-plugins"],
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "$eval-resource-events Create a pull request titled 'Stop resource monitoring', watch its checks and review feedback, and keep me posted here.",
          { thread },
        ),
      ],
      events: [mention("stop", { thread })],
      criteria: rubric({
        pass: [
          "Junior understands from the conversation that the terse follow-up asks it to stop monitoring the pull request.",
          "Junior briefly confirms that monitoring stopped.",
        ],
        fail: [
          "Do not require the user to repeat a special unsubscribe phrase.",
          "Do not ask which resource the user meant when the active monitoring target is clear from the conversation.",
        ],
      }),
    });

    const calls = toolCalls(result.session);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "watchResourceEvents",
          status: "ok",
        }),
        expect.objectContaining({
          name: "stopWatchingResources",
          status: "ok",
        }),
      ]),
    );
    const watch = calls.find((call) => call.name === "watchResourceEvents");
    const stop = calls.find((call) => call.name === "stopWatchingResources");
    if (!watch || watch.status !== "ok") {
      throw new Error("Expected a successful resource watch tool call");
    }
    if (
      !watch.result ||
      typeof watch.result !== "object" ||
      Array.isArray(watch.result) ||
      typeof watch.result.id !== "string"
    ) {
      throw new Error("Resource watch result did not contain an id");
    }
    expect(stop).toMatchObject({
      arguments: { id: watch.result.id },
      result: {
        stoppedIds: [watch.result.id],
        watching_status: "stopped",
      },
      status: "ok",
    });
  });

  it("when a subscribed event does not serve the intent, stay silent", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        githubWebhook({
          eventName: "check_suite",
          subscription: {
            events: ["pull_request.checks.recovered"],
            intent:
              "Let the original Slack thread know when Junior's pull request lands.",
            label: "GitHub PR getsentry/junior#702",
            identifier: "getsentry/junior#702",
            resourceType: "pull_request",
          },
          body: {
            action: "completed",
            repository: { full_name: "getsentry/junior" },
            check_suite: {
              conclusion: "success",
              head_sha: "abcdef1234567890",
              pull_requests: [{ number: 702 }],
            },
          },
        }),
      ],
    });
    expect(visibleThreadReplies(result.session)).toHaveLength(0);
  });
});
