import { describe, expect } from "vitest";
import { mention, reply } from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { validationLogs } from "../conversation/ci-results";

describe("Long resource investigation", () => {
  test("repairs the owner-scoped lookup and checks the earlier CI failure", async ({
    agent,
  }) => {
    const { run } = await agent({
      defaultProfile: "standard",
      profiles: { standard: "anthropic/claude-opus-5.5" },
    });
    const conversation = await run(
      mention(
        "Use /coding-workspace-fixture. The earlier CI run found an id-only resource lookup. Inspect project/src/resource-access.ts and its test. Fix the lookup so it checks organization and project as well as the resource ID. Run the focused test and tell me whether the rollout can ship.",
      ),
      {
        history: [
          mention(
            "Investigate the resource rollout across CI shards. Check access across organizations and projects before shipping.",
          ),
          reply("One shard failed. No code has changed yet.", {
            toolHistory: validationLogs(),
          }),
        ],
        criteria: rubric({
          pass: [
            "Reports a lookup scoped to the organization, project, and resource ID, and verifies it with a cross-organization and cross-project test before recommending the rollout.",
          ],
          fail: ["Claims the rollout already shipped."],
        }),
      },
    );
    expect(conversation.turns.at(-1)?.status).toBe("succeeded");
    const checks = completedToolCalls("bash", conversation).filter((call) =>
      JSON.stringify(call.input).includes("resource-access.test.ts"),
    );
    expect(
      checks.some((call) => {
        const result = toolOutput(call);
        return (
          result !== null &&
          typeof result === "object" &&
          "exit_code" in result &&
          result.exit_code === 0
        );
      }),
      "The scoped-resource test must pass before shipping",
    ).toBe(true);

    const followUp = await conversation.continue(
      mention(
        "What blocked the earlier CI run? Would you ship now or wait for the full CI rerun? Keep the answer short.",
      ),
      {
        criteria: rubric({
          pass: [
            "Recalls that an id-only lookup exposed another organization's resource, and waits for the full CI rerun before shipping.",
          ],
        }),
      },
    );
    expect(followUp.turns.at(-1)?.status).toBe("succeeded");
  });
});
