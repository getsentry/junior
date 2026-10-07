import { describe, expect } from "vitest";
import {
  mention,
  reply,
  type HistoryToolCall,
} from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// Older shards form observation-sized groups. The last shard stays raw.
// The default 400k context limit triggers capacity compaction at 360k.
const SHARDS = 21;

function priorCiResults(): HistoryToolCall[] {
  return Array.from({ length: SHARDS }, (_, shard) => {
    const checks = shard === SHARDS - 1 ? 950 : 390;
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
    // Both CI arms use the same run ID. A local run gets a new reference.
    // Neither value appears in the coding workspace.
    const auditReference = `audit-${
      /^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID ?? "")
        ? process.env.GITHUB_RUN_ID
        : crypto.randomUUID()
    }`;
    const { run } = await agent({
      defaultProfile: "standard",
      profiles: { standard: "openai/gpt-6-astra" },
    });
    const conversation = await run(
      mention(
        "From the earlier CI result, which resource check failed and what needs to change before the rollout can ship? Do not edit yet.",
      ),
      {
        history: [
          mention(
            `Check the resource rollout across organizations and projects. Its audit reference is ${auditReference}. Review the CI results before shipping.`,
          ),
          reply("The CI run is complete, but one shard failed.", {
            toolHistory: priorCiResults(),
          }),
        ],
      },
    );
    expect(conversation.turns.at(-1)?.status).toBe("succeeded");
    expect(conversation.compactions).toBe(0);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "Identifies the id-only lookup as the cross-organization access failure and calls for organization and project scoping.",
        ],
        fail: ["Does not claim the rollout shipped or the bug was fixed."],
      }),
    );

    const repaired = await conversation.continue(
      mention(
        "Fix the lookup so it checks organization, project, and resource id. Run resource-access.test.ts again, then tell me whether the rollout is ready to ship.",
      ),
    );
    expect(repaired.turns.at(-1)?.status).toBe("succeeded");
    await expect(repaired).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "Explains that the lookup now checks organization, project, and resource id. Reports a passing cross-organization and cross-project test.",
        ],
        fail: ["Does not claim the full rollout shipped or all CI passed."],
      }),
    );
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

    const review = await repaired.continue(
      mention(
        "What was the audit reference on the earlier CI run? Include the exact reference in the release note, and say which checks passed and which still need to run before shipping.",
      ),
    );
    expect(review.turns.at(-1)?.status).toBe("succeeded");
    expect(
      review.replies.some(({ text }) => text.includes(auditReference)),
    ).toBe(true);
    await expect(review).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "Reports that the focused resource-access test passed after the scoped lookup fix.",
          "Distinguishes the focused test from a full CI rerun. Does not say the rollout already shipped.",
        ],
        fail: [
          "Does not invent other verification or claim the full CI run passed.",
        ],
      }),
    );
  });
});
