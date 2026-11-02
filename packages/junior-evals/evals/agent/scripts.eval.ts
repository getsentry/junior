import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls, toolCallsOf } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The user never names codemode. These cases measure whether Junior picks a
// script when one call per item would be many calls, and skips it for one
// call.
describe("Code Mode Scripts", () => {
  test("when a request needs the same lookup for many items, run the lookups in one script", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "I'm planning a call across our offices. What's the current UTC offset right now in each of these timezones: America/Los_Angeles, America/New_York, America/Toronto, Europe/London, Europe/Vienna, Asia/Kolkata, Asia/Tokyo, Australia/Sydney? One line each.",
      ),
    );

    expect(completedToolCalls("codemode", conversation).length).toBeGreaterThan(
      0,
    );
    // The script makes the lookups, so few of them are direct calls.
    expect(toolCallsOf("systemTime", conversation).length).toBeLessThan(8);
    expect(conversation.replies).toHaveLength(1);
  });

  test("when one tool call answers the request, call the tool directly without a script", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC?"),
    );

    expect(toolCallsOf("codemode", conversation)).toEqual([]);
    expect(
      completedToolCalls("systemTime", conversation).length,
    ).toBeGreaterThan(0);
    expect(conversation.replies).toHaveLength(1);
  });
});
