import { describe, expect } from "vitest";
import { heartbeat, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
} from "@junior-evals/fixture/results";
import { test, type ToolCall } from "@junior-evals/fixture/test";

/** `owner/repo#number` of each issue that the agent created. */
function createdIssues(result: { toolCalls: ToolCall[] }): string[] {
  return completedToolCalls("github_createIssue", result).map((call) => {
    const repo = (call.input as { repo: string }).repo;
    const { number } = toolOutput(call) as { number: number };
    return `${repo}#${number}`;
  });
}

/** Dedupe keys of the Review items that the agent added. */
function reviewItemKeys(result: { toolCalls: ToolCall[] }): unknown[] {
  return toolCallsOf("addReviewItem", result).map(
    (call) => (call.input as { dedupe_key?: unknown }).dedupe_key,
  );
}

function threadsStarted(result: { toolCalls: ToolCall[] }): ToolCall[] {
  return completedToolCalls("spawnAgent", result).filter(
    (call) => (call.input as { kind?: unknown }).kind === "thread",
  );
}

// After an issue is created, whether Junior does the work is the
// requester's decision. These cases measure when Junior asks with a Review
// item, when it starts the work, and when it does neither.
describe("Filing Issues", () => {
  test("when someone only asks for an issue, file it and ask with a Review item whether to start a Thread", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "can you open an issue in acme/storefront? the cart page drops the coupon code when you reload it, so people have to type it again",
      ),
    );

    const [issue] = createdIssues(conversation);
    expect(issue, "No issue: this run does not test the next step").toEqual(
      expect.any(String),
    );
    expect(reviewItemKeys(conversation)).toContain(
      `github-issue-implement:${issue}`,
    );
    // The person did not ask for the work yet, so it waits for the answer.
    expect(threadsStarted(conversation)).toHaveLength(0);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply names or links the created issue."],
        fail: [
          "Do not ask in the reply text whether to start work on the issue.",
        ],
      }),
    );
  });

  test("when someone asks to file an issue and fix it, start a Thread without asking", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "the cart page in acme/storefront drops the coupon code when you reload it. file an issue for it and fix it",
      ),
    );

    expect(createdIssues(conversation)).toHaveLength(1);
    // Only the first Turn: a later Turn reads the Thread's result.
    const [first] = conversation.turns;
    expect(threadsStarted(first!)).toHaveLength(1);
    expect(reviewItemKeys(first!)).toEqual([]);
  });

  test("when an Automation run files an issue, do not ask whether to implement it", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: "File a GitHub issue in acme/storefront: the cart page drops the coupon code when it reloads. Then post the issue link here.",
    });

    const delivery = await run(heartbeat());

    expect(createdIssues(delivery)).toHaveLength(1);
    expect(reviewItemKeys(delivery)).toEqual([]);
    expect(threadsStarted(delivery)).toHaveLength(0);
  });

  test("when the issue hands work to another team, do not ask whether to implement it", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "can you file an issue in acme/payments-docs for the payments docs team? the refunds page still says refunds take 10 days, but they take 5 now. they own that page, I just want it on their radar",
      ),
    );

    expect(createdIssues(conversation)).toHaveLength(1);
    expect(reviewItemKeys(conversation)).toEqual([]);
    expect(threadsStarted(conversation)).toHaveLength(0);
  });
});
