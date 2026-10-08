import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Watches", () => {
  test("when a follow-up stops monitoring, cancel the selected watch before confirming", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Watch the checks and review feedback on getsentry/junior#691, and keep me posted here.",
      ),
    );
    const [watch] = completedToolCalls("watchEvents", conversation).map(
      (call) => toolOutput(call) as { id: string },
    );
    expect(watch?.id, "No watch: this run does not test stopping").toEqual(
      expect.any(String),
    );

    // A bare "stop" opts Junior out of the thread before any turn runs. This
    // follow-up needs the conversation to mean "stop the watch".
    const stopped = await conversation.continue(
      slackMention("you can stop now"),
    );
    await expect(stopped).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "Junior understands from the conversation that the terse follow-up asks it to stop monitoring the pull request.",
          "Junior briefly confirms that monitoring stopped.",
        ],
        fail: [
          "Do not require the user to repeat a special unsubscribe phrase.",
          "Do not ask which resource the user meant when the active monitoring target is clear from the conversation.",
        ],
      }),
    );

    expect(
      completedToolCalls("stopWatchingResources", stopped).map((call) => ({
        input: call.input,
        output: toolOutput(call),
      })),
    ).toEqual([
      {
        input: { id: watch!.id },
        output: expect.objectContaining({
          stoppedIds: [watch!.id],
          watching_status: "stopped",
        }),
      },
    ]);
  });
});
