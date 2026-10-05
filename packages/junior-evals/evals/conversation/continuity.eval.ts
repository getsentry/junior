import { describe, expect } from "vitest";
import {
  mention,
  reply,
  type HistoryToolCall,
} from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

const SHARDS = 20;
const CHECKS_PER_SHARD = 230;
const MODULES = ["resources", "projects", "permissions", "audit"] as const;

// A completed CI investigation has many small results and one blocking failure.
// The model sees them as completed tool calls, as it does after real coding work.
function validationLogs(): HistoryToolCall[] {
  return Array.from({ length: SHARDS }, (_, shard) => {
    const lines = Array.from({ length: CHECKS_PER_SHARD }, (_, check) => {
      const module = MODULES[(shard + check) % MODULES.length];
      const location = `tests/api/${module}/test_access.py::test_resource_${shard + 1}_${check + 1}`;
      if (shard === 10 && check === 114) {
        return `${location} FAIL org=org-red project=project-red resource=resource-115 expected=404 observed=200; lookup filtered by resource id only and returned the row owned by org-blue`;
      }
      return `${location} PASS org=org-red project=project-red resource=resource-${shard + 1}-${check + 1} expected=200 observed=200 duration=${((check % 17) + 1) / 100}s`;
    });
    return {
      name: "bash",
      arguments: { command: `pnpm test --shard=${shard + 1}/${SHARDS}` },
      result: {
        exit_code: shard === 10 ? 1 : 0,
        stdout: lines.join("\n"),
        stderr: "",
        timed_out: false,
      },
    };
  });
}

describe("Thread Continuity", () => {
  test("when a follow-up asks about the prior turn, recall the earlier budget context", async ({
    run,
  }) => {
    const conversation = await run(mention("what did i just ask?"), {
      history: [
        mention("I need the budget by Friday."),
        reply("Got it: budget due Friday."),
      ],
      criteria: rubric({
        pass: [
          "The reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    });

    expect(conversation.replies).toHaveLength(1);
  });

  test("continues a long CI investigation across two Turns", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "Read the earlier CI results. Which failure blocks the resource rollout, and what two checks would you make before shipping? Keep the answer concise.",
      ),
      {
        history: [
          mention(
            "Investigate the resource rollout across all CI shards. Check access across organizations and projects before shipping.",
          ),
          reply(
            "The CI run is complete. One shard failed; no code has changed.",
            {
              toolHistory: validationLogs(),
            },
          ),
        ],
        criteria: rubric({
          pass: [
            "Identifies the cross-organization resource read: the failing lookup uses the resource id without the owning organization or project. Says to scope the lookup and check that a different organization cannot read the resource before shipping.",
          ],
          fail: [
            "Does not claim the rollout shipped or the access bug was fixed.",
          ],
        }),
      },
    );
    expect(conversation.turns.at(-1)?.status).toBe("succeeded");

    const followUp = await conversation.continue(
      mention(
        "Would you ship the rollout now? Give the reason in one sentence.",
      ),
      {
        criteria: rubric({
          pass: [
            "Does not ship while an id-only lookup lets a different organization read a resource. Requires a scoped lookup and a passing cross-organization check first.",
          ],
        }),
      },
    );
    expect(followUp.turns.at(-1)?.status).toBe("succeeded");
  });
});
