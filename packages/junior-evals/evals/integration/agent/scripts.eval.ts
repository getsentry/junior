import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
  type ToolCall,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

/** The text that the model got back from each completed `codemode` call. */
function scriptResults(conversation: { toolCalls: ToolCall[] }): string[] {
  return completedToolCalls("codemode", conversation).map((call) =>
    String(toolOutput(call)),
  );
}

describe("Code Mode Scripts", () => {
  test("when a script calls tools at the same time, each call runs and the result lists it", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Use the codemode tool once: in one script, call systemTime for UTC and for Asia/Tokyo with Promise.all, and return both iso_local values. Then tell me both times.",
      ),
    );

    const results = scriptResults(conversation);
    expect(results).toContainEqual(
      expect.stringMatching(
        /^Script completed\.\nTool calls \(2\):\n1\. systemTime: ok\n2\. systemTime: ok\n/,
      ),
    );
    expect(conversation.replies).toHaveLength(1);
  });

  test("when a script prints more than the output limit, the result names a Sandbox file with the full text", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        'Use the codemode tool to run exactly this script: text("x".repeat(60000)); Then tell me the file path the result names.',
      ),
    );

    const results = scriptResults(conversation);
    expect(results).toContainEqual(
      expect.stringMatching(/\[cut: .* full: \/tmp\/jr\/\w+\./),
    );
    expect(conversation.replies).toHaveLength(1);
  });

  test("when a script reaches the turn limit, the turn wraps up instead of failing", async ({
    agent,
  }) => {
    // The codemode call and two nested calls use the whole budget.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 3 } });
    const conversation = await run(
      slackMention(
        "Use the codemode tool once: in one script, call systemTime five times, one after another, and count the calls that return a time. Then tell me that count.",
      ),
    );

    // The script may stop at the first refused call, so it can fail.
    const results = toolCallsOf("codemode", conversation).map((call) =>
      String(toolOutput(call)),
    );
    expect(results).toContainEqual(
      expect.stringMatching(
        /systemTime: failed\n {3}This Turn used its execution budget/,
      ),
    );
    expect(conversation.turns).toHaveLength(1);
    expect(conversation.turns[0]?.status).toBe("succeeded");
    expect(conversation.replies).toHaveLength(1);
  });
});
