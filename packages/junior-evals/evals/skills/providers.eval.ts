import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import {
  completedMcpToolCalls,
  mcpToolCallsOf,
  toolCallsOf,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Skill Providers", () => {
  test("when asked to double-check a source-backed fact, use the source and answer completely", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Can you double-check what the source handbook says about closed tracking issues proving capability support? I think there was a note for this.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The answer says closed tracking issues alone do not prove capability support.",
          "The answer says implementation evidence, linked PRs, release notes, issue comments, or an equivalent source-backed rationale is needed.",
        ],
        fail: [
          "Do not offer to check the source handbook next or later.",
          "Do not answer with generic capability advice that omits the source-handbook rule.",
          "Do not claim that a closed issue is enough to prove the capability exists.",
        ],
      }),
    );
  });

  test("when an MCP-backed skill handles a lookup, return the provider-backed answer", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/eval-mcp Ask the handbook what it says about US holidays, then summarize the result.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The visible thread output includes a final answer based on the demo MCP provider result.",
          "The visible thread output refers to the handbook or US holidays request.",
          "The visible thread output does not claim the MCP lookup was blocked by missing arguments.",
        ],
        fail: [
          'Do not include `expected string, received undefined` or `"query"` argument validation errors.',
          "Do not ask the user to provide a page URL or repeat the request.",
          "Do not say the MCP runtime is broken or that the lookup cannot be attempted.",
        ],
      }),
    );

    expect(
      completedMcpToolCalls("mcp__eval-mcp__handbook-search", conversation).map(
        (call) => call.input,
      ),
    ).toContainEqual(
      expect.objectContaining({
        arguments: expect.objectContaining({
          query: expect.stringMatching(/US holidays/i),
        }),
      }),
    );
    // The command already put the skill in the turn.
    expect(
      toolCallsOf("loadSkill", conversation).map((call) => call.input),
    ).not.toContainEqual(expect.objectContaining({ skill_name: "eval-mcp" }));
    expect(conversation.replies).toHaveLength(1);
  });

  test("when an MCP tool has mutually exclusive filters, use only the provided filter", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "/eval-directory Find alice@example.com in the directory and tell me whether the account is active.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The answer identifies Alice Example or alice@example.com and says the account is active.",
          "The lookup succeeds without asking the user for another identifier.",
        ],
        fail: [
          "Do not say the lookup failed because multiple filters were provided.",
          "Do not ask for a user id, name query, or other information unnecessary for the email lookup.",
        ],
      }),
    );

    expect(
      mcpToolCallsOf("mcp__eval-mcp__find-person", conversation).map(
        (call) => call.input,
      ),
    ).toContainEqual(
      expect.objectContaining({ arguments: { email: "alice@example.com" } }),
    );
  });
});
