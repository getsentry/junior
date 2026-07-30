import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import {
  mention,
  rubric,
  slackEvals,
  threadMessage,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Skill Providers", slackEvals, (it) => {
  it("when asked to double-check a source-backed fact, use the source and answer completely", async ({
    run,
  }) => {
    const result = await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      initialEvents: [
        mention(
          "Can you double-check what the source handbook says about closed tracking issues proving capability support? I think there was a note for this.",
        ),
      ],
      criteria: rubric({
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
    });

    expect(visibleThreadReplies(result.session).length).toBeGreaterThan(0);
  });

  it("when an MCP-backed skill handles a lookup, return the provider-backed answer", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        mention(
          "/eval-mcp Ask the handbook what it says about US holidays, then summarize the result.",
        ),
      ],
      criteria: rubric({
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
    });
    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "callMcpTool",
          arguments: expect.objectContaining({
            tool_name: "mcp__eval-mcp__handbook-search",
            arguments: expect.objectContaining({
              query: expect.stringMatching(/US holidays/i),
            }),
          }),
        }),
      ]),
    );
    expect(toolCalls(result.session)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "loadSkill",
          arguments: expect.objectContaining({ skill_name: "eval-mcp" }),
        }),
      ]),
    );
  });

  it("when an MCP tool has mutually exclusive filters, use only the provided filter", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        mention(
          "/eval-directory Find alice@example.com in the directory and tell me whether the account is active.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The answer identifies Alice Example or alice@example.com and says the account is active.",
          "The lookup succeeds without asking the user for another identifier.",
        ],
        fail: [
          "Do not say the lookup failed because multiple filters were provided.",
          "Do not ask for a user id, name query, or other information unnecessary for the email lookup.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "callMcpTool",
          arguments: expect.objectContaining({
            tool_name: "mcp__eval-mcp__find-person",
            arguments: {
              email: "alice@example.com",
            },
          }),
        }),
      ]),
    );
  });
});
