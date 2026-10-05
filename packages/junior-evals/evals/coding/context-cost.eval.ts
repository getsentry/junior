import { describe, expect } from "vitest";
import {
  mention,
  reply,
  type HistoryToolCall,
} from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const SHARDS = 11;

function priorCiResults(): HistoryToolCall[] {
  return Array.from({ length: SHARDS }, (_, shard) => {
    const checks = shard === SHARDS - 1 ? 530 : 390;
    const lines = Array.from({ length: checks }, (_, check) => {
      const location = `tests/api/resources/test_access.py::test_resource_${shard + 1}_${check + 1}`;
      if (shard === SHARDS - 1 && check === 114) {
        return `${location} FAIL org=org-red project=project-red resource=resource-115 expected=404 observed=200; lookup filtered by resource id only and returned the row owned by org-blue`;
      }
      return `${location} PASS org=org-red project=project-red resource=resource-${shard + 1}-${check + 1} expected=200 observed=200 duration=${((check % 17) + 1) / 100}s`;
    });
    return {
      name: "bash",
      arguments: { command: `pnpm test --shard=${shard + 1}/${SHARDS}` },
      result: {
        exit_code: shard === SHARDS - 1 ? 1 : 0,
        stdout: lines.join("\n"),
        stderr: "",
        timed_out: false,
      },
    };
  });
}

describe("Priced Conversation context", () => {
  test("repairs a scoped lookup after checking a long CI run", async ({
    agent,
  }) => {
    const { run } = await agent({
      defaultProfile: "standard",
      profiles: { standard: "openai/gpt-6-astra" },
    });
    const conversation = await run(
      mention(
        "Check why the resource rollout failed. Read project/src/resource-access.ts and its test, then run the focused test. Tell me what needs to change, but do not edit yet.",
      ),
      {
        history: [
          mention(
            "Check the resource rollout across organizations and projects. Review the CI results before shipping.",
          ),
          reply("The CI run is complete, but one shard failed.", {
            toolHistory: priorCiResults(),
          }),
        ],
        criteria: rubric({
          pass: [
            "Identifies the id-only lookup as the cross-organization access failure and calls for organization and project scoping.",
          ],
          fail: ["Does not claim the rollout shipped or the bug was fixed."],
        }),
      },
    );
    expect(conversation.turns.at(-1)?.status).toBe("succeeded");

    const repaired = await conversation.continue(
      mention(
        "Fix the lookup so it checks organization, project, and resource id. Run resource-access.test.ts again, then tell me whether the rollout is ready to ship.",
      ),
      {
        criteria: rubric({
          pass: [
            "Explains that the lookup now checks organization, project, and resource id. Reports a passing cross-organization and cross-project test.",
          ],
          fail: ["Does not claim the full rollout shipped or all CI passed."],
        }),
      },
    );
    expect(repaired.turns.at(-1)?.status).toBe("succeeded");
    expect(
      completedToolCalls("bash", repaired).some((call) => {
        const command = (call.input as { command?: unknown }).command;
        const output = toolOutput(call) as { exit_code?: number };
        return (
          typeof command === "string" &&
          command.includes("resource-access.test.ts") &&
          output.exit_code === 0
        );
      }),
    ).toBe(true);
  });
});
