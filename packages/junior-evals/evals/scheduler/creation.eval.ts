import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Schedule Creation", () => {
  test("when a reminder for the requester posts to the channel, save it for the Automation creator", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "every Friday at 4pm Pacific, remind me in this channel to submit my timesheet",
      ),
    );

    const creates = completedToolCalls("createAutomation", conversation);
    expect(creates).toHaveLength(1);
    // Each run reads "the Automation creator" as its creator. "Me" has no
    // meaning to a run that does not see this request.
    const { instruction } = creates[0]!.input as { instruction?: string };
    expect(instruction).toMatch(/\bAutomation creator\b/i);
    expect(instruction).not.toMatch(/\b(?:me|my)\b/i);
  });
});
