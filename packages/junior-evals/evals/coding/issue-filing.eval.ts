import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
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

/** Dedupe keys of the Inbox items that the agent added. */
function inboxItemKeys(result: { toolCalls: ToolCall[] }): unknown[] {
  return toolCallsOf("addInboxItem", result).map(
    (call) => (call.input as { dedupe_key?: unknown }).dedupe_key,
  );
}

/** The people each created issue waits on, as the agent named them. */
function reviewers(result: { toolCalls: ToolCall[] }): unknown[] {
  return completedToolCalls("github_createIssue", result).map(
    (call) => (call.input as { review_by?: unknown }).review_by ?? [],
  );
}

function threadsStarted(result: { toolCalls: ToolCall[] }): ToolCall[] {
  return completedToolCalls("spawnAgent", result).filter(
    (call) => (call.input as { kind?: unknown }).kind === "thread",
  );
}

// After an issue is created, whether Junior does the work is the
// requester's decision. These cases measure when Junior asks with a Review
// item, when it starts the work, and when it does neither. Automation runs
// get no note at all; `github-plugin.test.ts` covers that fixed rule.
describe("Filing Issues", () => {
  test("when someone only asks for an issue, file it and ask with an Inbox item whether to start a Thread", async ({
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
    expect(inboxItemKeys(conversation)).toContain(
      `github-issue-implement:${issue}`,
    );
    // The person did not ask for the work yet, so it waits for the answer.
    expect(threadsStarted(conversation)).toHaveLength(0);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      // Visible text includes the Inbox item, so the judge checks only
      // that the issue is named.
      rubric({ pass: ["The reply names or links the created issue."] }),
    );
  });

  test("when someone asks to file an issue and fix it, start a Thread without asking", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "the cart page in acme/storefront drops the coupon code when you reload it. file an issue for it, then fix it",
      ),
    );

    expect(createdIssues(conversation)).toHaveLength(1);
    // Only the first Turn: a later Turn reads the Thread's result.
    const [first] = conversation.turns;
    expect(threadsStarted(first!)).toHaveLength(1);
    expect(inboxItemKeys(first!)).toEqual([]);
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
    expect(inboxItemKeys(conversation)).toEqual([]);
    expect(threadsStarted(conversation)).toHaveLength(0);
  });

  test("when someone asks for a design issue to review, the issue waits on their review", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "can you open a design issue in acme/storefront that proposes keeping the cart in the URL instead of local storage? I want to review the approach before anyone builds it",
      ),
    );

    const [issueReviewers] = reviewers(conversation);
    expect(issueReviewers).toEqual([expect.any(String)]);
  });

  test("when someone files a bug to track it, the issue waits on no one", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "file an issue in acme/storefront so we track it: the cart page drops the coupon code when you reload it",
      ),
    );

    expect(reviewers(conversation)).toEqual([[]]);
  });
});
