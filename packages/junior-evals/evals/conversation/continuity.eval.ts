import { describe, expect } from "vitest";
import { mention, reply } from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";
import { validationLogs } from "./ci-results";

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
