import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { mention, rubric, slackEvals, threadMessage } from "../../src/helpers";

describeEval("Skill Infrastructure", slackEvals, (it) => {
  it("when the candidate brief command runs, return one candidate brief reply", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      events: [mention("/candidate-brief David Cramer")],
      criteria: rubric({
        pass: [
          "The assistant posts exactly one reply for David Cramer.",
          "The reply is a candidate brief with role, team, and location-style details.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    });
  });

  const candidateBriefThread = {
    id: "thread-candidate-brief-repeat",
    channel_id: "CCANDIDATEBRIEF",
    thread_ts: "17000000.candidate-brief",
  };

  it("when the candidate brief command runs twice in one thread, keep the replies ordered", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      events: [
        mention("/candidate-brief Alice Example", {
          thread: candidateBriefThread,
        }),
        threadMessage("/candidate-brief Bob Example", {
          thread: candidateBriefThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "Across two turns in one thread, the assistant posts exactly two replies in order: Alice first, then Bob.",
          "Each reply addresses the requested candidate by name.",
          "Each reply provides a brief with role, team, and location-style details.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    });
  });

  it("when the working-directory command runs, return one file-list reply", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      events: [mention("/list-working-directory")],
      criteria: rubric({
        pass: [
          "The assistant posts exactly one working-directory listing reply.",
          "That reply includes a file-list section such as 'Working directory files:'.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    });
  });

  it("when asked to double-check a source-backed fact, use the source and answer completely", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      events: [
        mention(
          "Can you double-check what the source handbook says about closed tracking issues proving capability support? I think there was a note for this.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant posts exactly one final answer.",
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
  });

  it("when an MCP-backed skill handles a lookup, return the provider-backed answer", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        plugin_dirs: ["fixtures/plugins"],
      },
      events: [
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
          name: "loadSkill",
          arguments: expect.objectContaining({
            skill_name: "eval-mcp",
          }),
        }),
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
  });
});
