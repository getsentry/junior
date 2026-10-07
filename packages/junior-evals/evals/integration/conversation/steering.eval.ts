import { describe, expect } from "vitest";
import {
  slackMention,
  person,
  slackThreadMessage,
} from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { sendDuringFirstModelRequest } from "@junior-evals/fixture/progress";
import { test } from "@junior-evals/fixture/test";

// A plain reply keeps each turn to one model call. Routing is the behavior
// under test, not the summary.
const INCIDENT_REQUEST =
  "In two sentences, summarize the checkout outage: payments failed for 20 minutes after the 14:05 deploy.";

// With passive routing, Junior can answer a thread message that has no
// mention. Without it, no such message starts a turn, so a check for "no
// turn" cannot fail.
const PASSIVE_ROUTING = { experimental: { "passive-routing": true } };

describe("Slack Turn Steering", () => {
  test("when the same person mentions Junior during a turn, the running turn takes the mention", async ({
    run,
  }) => {
    const conversation = await run(slackMention(INCIDENT_REQUEST), {
      onProgress: sendDuringFirstModelRequest([
        slackMention("include the rollback owner: Dana"),
      ]),
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["A reply says Dana is the rollback owner."],
      }),
    );

    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
    expect(conversation.reactions).toContain("white_check_mark");
  });

  test("when other people mention Junior during a turn, each person gets a follow-up turn unless they override with !!", async ({
    run,
  }) => {
    // Only routing is asserted, so the inputs are manufactured and short.
    const shortReply = (word: string) => `Reply with only the word ${word}.`;
    const conversation = await run(
      slackMention(shortReply("ready"), { author: person("U0SAM", "Sam") }),
      {
        onProgress: sendDuringFirstModelRequest([
          slackMention(shortReply("one"), { author: person("U0RIO", "Rio") }),
          slackMention(shortReply("two"), { author: person("U0RIO", "Rio") }),
          slackMention(shortReply("three"), { author: person("U0KAI", "Kai") }),
          slackMention(shortReply("four"), { author: person("U0RIO", "Rio") }),
          slackMention(`!! ${shortReply("go")}`, {
            author: person("U0ALEX", "Alex"),
          }),
        ]),
      },
    );

    // Sam's turn, then Rio, Kai, and Rio again in arrival order. Alex's !!
    // mention joins Sam's running turn.
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  test("when cross-actor steering is configured, another person's mention joins the running turn", async ({
    agent,
  }) => {
    const { run } = await agent({
      slack: { crossActorMidRunMode: "steer" },
    });
    const conversation = await run(
      slackMention(INCIDENT_REQUEST, { author: person("U0SAM", "Sam") }),
      {
        onProgress: sendDuringFirstModelRequest([
          slackMention("include the rollback owner: Dana", {
            author: person("U0RIO", "Rio"),
          }),
        ]),
      },
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The summary names Dana as the rollback owner."],
      }),
    );

    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
  });

  test("when a thread message needs no reply, Junior consumes it without a turn", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(slackMention(INCIDENT_REQUEST));
    expect(conversation.replies.length).toBeGreaterThan(0);

    const next = await conversation.continue(
      slackThreadMessage("thanks, sounds good"),
    );
    expect(next.turns).toEqual([]);
    expect(next.replies).toEqual([]);
    expect(next.reactions).toEqual([]);
  });

  test("when someone says stop during a turn, Junior stops and stays out of the thread", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(slackMention(INCIDENT_REQUEST), {
      // The mention waits for a follow-up turn; the stop discards it.
      onProgress: sendDuringFirstModelRequest([
        slackMention("also list the affected regions"),
        slackThreadMessage("stop"),
      ]),
    });

    expect(conversation.turns.map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(conversation.replies.map((reply) => reply.text)).toEqual([
      expect.stringContaining("stay out of this thread"),
    ]);
    expect(conversation.reactions).not.toContain("white_check_mark");

    const next = await conversation.continue(
      slackThreadMessage("what about the regions?"),
    );
    expect(next.turns).toEqual([]);
  });
});
