import { describe, expect } from "vitest";
import {
  mention,
  reply,
  type HistoryToolCall,
} from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { handoffHistory } from "../integration/coding/handoff-history";

const SHARDS = 20;
const CHECKS_PER_SHARD = 230;

function isolationLogs(): HistoryToolCall[] {
  return Array.from({ length: SHARDS }, (_, shard) => {
    const lines = Array.from({ length: CHECKS_PER_SHARD }, (_, check) => {
      const location = `tests/work-object/test_isolation.py::test_identity_${shard + 1}_${check + 1}`;
      if (shard === 10 && check === 114) {
        return `${location} FAIL org=org-red provider=github key=shared expected=distinct-from-org-blue observed=same-work-object-id; the identifier contains provider and key but no organization id`;
      }
      return `${location} PASS org=org-red provider=github key=object-${shard + 1}-${check + 1} expected=stable-within-org observed=stable-within-org duration=${((check % 17) + 1) / 100}s`;
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

describe("Long coding Conversation", () => {
  test("repairs an organization ID collision and checks what remains", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        "The earlier CI results show a Work Object ID collision between organizations. In skills/coding-workspace-fixture/project/src/work-object.ts, include organizationId in workObjectId so the same provider and key in different organizations have different IDs. Keep IDs stable across threads. Make the local source edit and run a direct check. Do not push. Tell me what still needs verification before shipping.",
      ),
      {
        history: [
          ...handoffHistory(),
          mention(
            "Check Work Object ID isolation across organizations before shipping. Keep the CI outputs and report any failing check.",
          ),
          reply("One CI shard failed. No code changed after this run.", {
            toolHistory: isolationLogs(),
          }),
        ],
        criteria: rubric({
          pass: [
            "Explains that the Work Object ID now includes the organization identifier, so the same provider and key can have different IDs across organizations while remaining stable in one organization. States that the actual lookup must also scope by organization and needs a cross-organization test before shipping.",
          ],
          fail: [
            "Do not claim the lookup is fixed or a pull request was pushed without evidence.",
          ],
        }),
      },
    );
    expect(
      completedToolCalls("editFile", { toolCalls: conversation.toolCalls })
        .length,
    ).toBeGreaterThan(0);

    const followUp = await conversation.continue(
      mention(
        "Would you ship the access fix now? State the remaining check in one sentence.",
      ),
      {
        criteria: rubric({
          pass: [
            "Does not ship until the actual resource lookup is scoped by organization and a cross-organization access check passes. Distinguishes the changed Work Object ID from the lookup fix.",
          ],
        }),
      },
    );
    expect(followUp.turns.at(-1)?.status).toBe("succeeded");
  });
});
