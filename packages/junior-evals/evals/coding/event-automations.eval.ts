import { describe, expect } from "vitest";
import type { ToolCall } from "@junior-evals/fixture/test";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

function triggerEvents(call: ToolCall): string[] {
  const input = call.input as { trigger?: { events?: unknown } } | undefined;
  const events = input?.trigger?.events;
  if (
    !Array.isArray(events) ||
    !events.every((event) => typeof event === "string")
  ) {
    throw new Error("Event automation call did not contain trigger events");
  }
  return events;
}

describe("Event automation creation", () => {
  test("when one GitHub issue has multiple requested states, create one event automation", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Create one event automation for GitHub issue getsentry/junior#208. Whenever it is closed or reopened, summarize the state change in this channel.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms that one event automation will react when the issue is closed or reopened.",
          "The reply accurately describes summarizing the issue state change in this channel.",
        ],
        fail: [
          "Do not create separate tasks for closed and reopened.",
          "Do not claim that `watchEvents`, a polling schedule, or a recurring timer was created instead of the event automation.",
        ],
      }),
    );

    const creates = completedToolCalls("createAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      trigger: {
        type: "event",
        namespace: "github",
        match: { repo: "getsentry/junior", issue: 208 },
      },
    });
    expect(new Set(triggerEvents(creates[0]!))).toEqual(
      new Set(["issue.closed", "issue.reopened"]),
    );
    const names = conversation.toolCalls.map((call) => call.name);
    expect(names).not.toContain("watchEvents");
  });

  test("when issue activity spans a repository, create one repo-wide event automation", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Create one event automation for getsentry/junior. Whenever any issue is closed or reopened, summarize the state change in this channel.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms one repository-wide event automation for issue closures and reopenings.",
          "The reply accurately says matching issue state changes will be summarized in this channel.",
        ],
        fail: [
          "Do not narrow the task to one issue number.",
          "Do not create separate tasks for closed and reopened issues.",
          "Do not claim that `watchEvents` or a polling schedule was created instead of the event automation.",
        ],
      }),
    );

    const creates = completedToolCalls("createAutomation", conversation);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      trigger: { type: "event", namespace: "github" },
    });
    expect(toolOutput(creates[0]!)).toMatchObject({
      automation: { trigger: { match: { repo: "getsentry/junior" } } },
    });
    expect(
      (
        toolOutput(creates[0]!) as {
          automation: { trigger: { match: object } };
        }
      ).automation.trigger.match,
    ).not.toHaveProperty("issue");
    expect(new Set(triggerEvents(creates[0]!))).toEqual(
      new Set(["issue.closed", "issue.reopened"]),
    );
  });
});
