import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { rubric } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Conversation Storage", () => {
  test("when asked about an earlier public thread in the same workspace, search stored conversation history", async ({
    run,
  }) => {
    // Each run() posts to a new thread in a new public channel.
    await run(
      mention(
        "Record this decision for our launch: the rollback owner is Priya.",
      ),
    );
    const conversation = await run(
      mention("Who did we name as the rollback owner in the earlier thread?"),
      {
        criteria: rubric({
          pass: [
            "The assistant answers that Priya was named as the rollback owner.",
            "The answer is based on a search of the earlier public Junior conversation in the same Slack workspace.",
          ],
          fail: [
            "Do not claim the earlier decision is unavailable.",
            "Do not ask the user to paste the earlier thread.",
          ],
        }),
      },
    );

    expect(
      completedToolCalls("searchConversationMessages", conversation),
    ).not.toHaveLength(0);
  });
});
