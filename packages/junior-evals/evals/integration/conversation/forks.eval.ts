import { describe, expect } from "vitest";
import { mention, reply, webMessage } from "../../../src/fixture/inputs";
import { rubric } from "../../../src/fixture/judge";
import { test } from "../../../src/fixture/test";

describe("Conversation Forks", () => {
  test("when a delivered reply is forked, the fork continues on its own", async ({
    run,
  }) => {
    const source = await run(
      webMessage(
        "We picked the blue option for the launch banner. Please confirm in one sentence.",
      ),
    );
    expect(source.replies).toHaveLength(1);

    const fork = await source.fork(source.replies[0]!);
    expect(fork.conversationId).not.toBe(source.conversationId);

    const next = await fork.continue(
      webMessage("Which color did we pick for the launch banner?"),
      {
        criteria: rubric({
          pass: ["The reply says the launch banner uses the blue option."],
        }),
      },
    );
    expect(next.replies).toHaveLength(1);
    expect(next.turns.map((turn) => turn.status)).toEqual(["succeeded"]);

    // The source does not see the fork's turn.
    const sourceNext = await source.continue(
      webMessage("Did anyone ask you about the banner color after this?"),
      {
        criteria: rubric({
          pass: [
            "The reply does not claim that a later question about the banner color was asked in this conversation.",
          ],
        }),
      },
    );
    expect(sourceNext.replies).toHaveLength(1);
  });

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
    expect(source.replies.length).toBeLessThanOrEqual(1);

    const fork = await source.fork(decision);
    const next = await fork.continue(
      webMessage("Which color is the launch banner right now?"),
      {
        criteria: rubric({
          pass: ["The reply says the launch banner is blue."],
          fail: ["Do not say the banner is green or was switched to green."],
        }),
      },
    );
    expect(next.replies).toHaveLength(1);
  });

  test("when a fork is forked, each fork continues from its own reply", async ({
    run,
  }) => {
    const source = await run(webMessage("The release codename is Maple."), {
      history: [],
    });
    const fork = await source.fork(source.replies[0]!);
    const forkTurn = await fork.continue(
      webMessage("Change the release codename to Birch."),
    );
    expect(forkTurn.replies).toHaveLength(1);

    const nested = await forkTurn.fork(forkTurn.replies[0]!);
    const nestedTurn = await nested.continue(
      webMessage("What is the release codename now?"),
      {
        criteria: rubric({
          pass: ["The reply says the release codename is Birch."],
        }),
      },
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
      {
        criteria: rubric({
          pass: ["The reply says the release codename is Maple."],
        }),
      },
    );
    expect(next.replies).toHaveLength(1);
  });
});
