import { describe, expect } from "vitest";
import { mention, reply, webMessage } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

describe("Conversation Forks", () => {
  test("when a loaded reply is forked, the fork does not know later turns", async ({
    run,
  }) => {
    const decision = reply("We picked the blue option for the launch banner.");
    const source = await run(webMessage("Thanks, that is all for now."), {
      history: [
        webMessage("Pick an option for the launch banner: blue or green."),
        decision,
        webMessage("Actually, switch the banner to green."),
        reply("Done: the launch banner is now green."),
      ],
    });

    const fork = await source.fork(decision);
    const next = await fork.continue(
      webMessage("Which color is the launch banner right now?"),
    );
    await expect(next.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply says the launch banner is blue."],
        fail: ["Do not say the banner is green or was switched to green."],
      }),
    );
    expect(next.replies).toHaveLength(1);
  });

  test("when a fork is forked, each fork continues from its own reply", async ({
    run,
  }) => {
    const source = await run(webMessage("The release codename is Maple."));
    expect(source.replies).toHaveLength(1);
    const fork = await source.fork(source.replies[0]!);
    const forkTurn = await fork.continue(
      webMessage("Change the release codename to Birch."),
    );
    expect(forkTurn.replies).toHaveLength(1);

    const nested = await forkTurn.fork(forkTurn.replies[0]!);
    const nestedTurn = await nested.continue(
      webMessage("What is the release codename now?"),
    );
    await expect(nestedTurn.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply says the release codename is Birch."],
      }),
    );
    expect(nestedTurn.replies).toHaveLength(1);
  });

  test("when a private Slack thread is forked, the fork continues from its reply", async ({
    run,
  }) => {
    const source = await run(
      mention(
        "The release codename is Maple. Confirm it in one short sentence.",
      ),
    );
    expect(source.replies).toHaveLength(1);

    const fork = await source.fork(source.replies[0]!);
    const next = await fork.continue(
      webMessage("What is the release codename?"),
    );
    await expect(next.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply says the release codename is Maple."],
      }),
    );
    expect(next.replies).toHaveLength(1);
  });
});
