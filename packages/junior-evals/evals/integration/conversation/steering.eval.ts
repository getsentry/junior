import { describe, expect } from "vitest";
import {
  mention,
  threadMessage,
  type Input,
} from "../../../src/fixture/inputs";
import { rubric } from "../../../src/fixture/judge";
import { test, type CallOptions } from "../../../src/fixture/test";

const INCIDENT_REQUEST =
  "start a short incident summary for the checkout outage: payments failed for 20 minutes after the 14:05 deploy.";

/** Send `inputs` while the first agent model request waits. */
function sendDuringFirstModelRequest(
  inputs: Input[],
): NonNullable<CallOptions["onProgress"]> {
  let sent = false;
  return async (progress, { send }) => {
    if (sent || progress.type !== "model_request") return;
    sent = true;
    for (const input of inputs) {
      await send(input);
    }
  };
}

const person = (userId: string, name: string) => ({
  fullName: `${name} Example`,
  userId,
  userName: name.toLowerCase(),
});

describe("Slack Turn Steering", () => {
  test("when the same person mentions Junior during a turn, the running turn takes the mention", async ({
    run,
  }) => {
    const conversation = await run(mention(INCIDENT_REQUEST), {
      onProgress: sendDuringFirstModelRequest([
        threadMessage("thanks folks"),
        mention("include the rollback owner: Dana"),
      ]),
      criteria: rubric({
        pass: ["A reply says Dana is the rollback owner."],
      }),
    });

    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
    expect(conversation.reactions).toContain("white_check_mark");
  });

  test("when other people mention Junior during a turn, each person gets a follow-up turn unless they override with !!", async ({
    run,
  }) => {
    // Routing is the behavior here, so every request needs only a short reply.
    const conversation = await run(
      mention("reply with only the word ready", {
        author: person("U0SAM", "Sam"),
      }),
      {
        onProgress: sendDuringFirstModelRequest([
          mention("reply with only the word one", {
            author: person("U0RIO", "Rio"),
          }),
          mention("reply with only the word two", {
            author: person("U0RIO", "Rio"),
          }),
          mention("reply with only the word three", {
            author: person("U0KAI", "Kai"),
          }),
          mention("reply with only the word four", {
            author: person("U0RIO", "Rio"),
          }),
          mention("!! also add the word go", {
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
      mention(INCIDENT_REQUEST, { author: person("U0SAM", "Sam") }),
      {
        onProgress: sendDuringFirstModelRequest([
          mention("include the rollback owner: Dana", {
            author: person("U0RIO", "Rio"),
          }),
        ]),
        criteria: rubric({
          pass: ["The summary names Dana as the rollback owner."],
        }),
      },
    );

    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
  });

  test("when a thread message needs no reply, Junior consumes it without a turn", async ({
    run,
  }) => {
    const conversation = await run(mention(INCIDENT_REQUEST));
    expect(conversation.replies.length).toBeGreaterThan(0);

    const next = await conversation.continue(
      threadMessage("thanks, sounds good"),
    );
    expect(next.turns).toEqual([]);
    expect(next.replies).toEqual([]);
  });

  test("when someone says stop during a turn, Junior stops and stays out of the thread", async ({
    run,
  }) => {
    const conversation = await run(mention(INCIDENT_REQUEST), {
      onProgress: sendDuringFirstModelRequest([
        mention("also list the affected regions"),
        threadMessage("stop"),
      ]),
    });

    expect(conversation.turns.map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(conversation.replies.map((reply) => reply.text)).toEqual([
      expect.stringContaining("stay out of this thread"),
    ]);
    expect(conversation.reactions).not.toContain("white_check_mark");

    const next = await conversation.continue(
      threadMessage("what about the regions?"),
    );
    expect(next.turns).toEqual([]);
  });
});
