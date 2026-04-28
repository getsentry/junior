import { describe } from "vitest";
import { mention, rubric, slackEval, threadMessage } from "../helpers";

describe("Skill Infrastructure", () => {
  slackEval(
    "when the candidate brief command runs, return one candidate brief reply",
    {
      overrides: { skill_dirs: ["evals/fixtures/skills"] },
      events: [mention("/candidate-brief David Cramer")],
      criteria: rubric({
        contract:
          "A skill command can return a single candidate brief in one reply.",
        pass: [
          "The assistant posts exactly one reply for David Cramer.",
          "The reply is a candidate brief with role, team, and location-style details.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    },
  );

  const candidateBriefThread = {
    id: "thread-candidate-brief-repeat",
    channel_id: "C-candidate-brief",
    thread_ts: "17000000.candidate-brief",
  };

  slackEval(
    "when the candidate brief command runs twice in one thread, keep the replies ordered",
    {
      overrides: { skill_dirs: ["evals/fixtures/skills"] },
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
        contract:
          "The same skill can be invoked twice in one thread without losing ordering or context.",
        pass: [
          "Across two turns in one thread, the assistant posts exactly two replies in order: Alice first, then Bob.",
          "Each reply addresses the requested candidate by name.",
          "Each reply provides a brief with role, team, and location-style details.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    },
  );

  slackEval(
    "when the working-directory command runs, return one file-list reply",
    {
      overrides: { skill_dirs: ["evals/fixtures/skills"] },
      events: [mention("/list-working-directory")],
      criteria: rubric({
        contract:
          "A simple infrastructure skill can list the working directory in one reply.",
        pass: [
          "The assistant posts exactly one working-directory listing reply.",
          "That reply includes a file-list section such as 'Working directory files:'.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    },
  );

  slackEval(
    "when an MCP-backed skill handles a lookup, return the provider-backed answer",
    {
      overrides: {
        plugin_dirs: ["evals/fixtures/plugins"],
      },
      events: [
        mention(
          "/eval-mcp Ask the handbook what it says about US holidays, then summarize the result.",
        ),
      ],
      taskTimeout: 120_000,
      timeout: 300_000,
      criteria: rubric({
        contract:
          "An MCP-backed skill can complete a natural lookup by using the provider result instead of surfacing tool validation errors.",
        pass: [
          "observed_tool_invocations includes `callMcpTool` with `mcp_tool_name` set to `mcp__eval-mcp__handbook-search`.",
          "That `callMcpTool` invocation includes `mcp_arguments.query` containing the handbook or US holidays lookup request.",
          "The visible thread output includes a final answer based on the demo MCP provider result.",
          "The visible thread output refers to the handbook or US holidays request.",
          "The visible thread output does not claim the MCP lookup was blocked by missing arguments.",
        ],
        allow: [
          "The final answer may be a concise paraphrase of the eval handbook result.",
        ],
        fail: [
          'Do not include `expected string, received undefined` or `"query"` argument validation errors.',
          "Do not ask the user to provide a page URL or repeat the request.",
          "Do not say the MCP runtime is broken or that the lookup cannot be attempted.",
        ],
      }),
    },
  );
});
