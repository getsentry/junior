import { describe, expect } from "vitest";
import { heartbeat, person, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolCallsOf } from "@junior-evals/fixture/results";
import { test, type ToolCall } from "@junior-evals/fixture/test";

const MAYA = person("UMAYA", "Maya");

interface AskedQuestion {
  header: string;
  multiSelect?: boolean | null;
  options: Array<{ description: string; label: string }>;
  question: string;
}

/** The `questions` of each `askUserQuestion` call that the agent made. */
function askedQuestions(conversation: {
  toolCalls: ToolCall[];
}): AskedQuestion[][] {
  return completedToolCalls("askUserQuestion", conversation).map(
    (call) => (call.input as { questions: AskedQuestion[] }).questions,
  );
}

describe("Asking a Person", () => {
  test("when the work needs facts that only the person knows, ask with askUserQuestion", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Can you write my out-of-office auto-reply for my vacation? It should say the day I'm back, and point people to Sam for anything urgent.",
        { author: MAYA },
      ),
    );

    // Only Maya knows the day she is back. The agent asks in the Inbox, not
    // in plain text.
    expect(askedQuestions(conversation)).not.toHaveLength(0);
  });

  test("when the person must make several decisions, ask each as its own question in one call", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Set up the on-call rotation for the payments team. I still have to decide two things: whether shifts are weekly or daily, and whether the rotation pages in Slack or in PagerDuty. Ask me.",
        { author: MAYA },
      ),
    );

    // One call holds both decisions, each with its own question and
    // choices, so each answer maps to its question.
    const asks = askedQuestions(conversation);
    expect(asks).toHaveLength(1);
    const [questions] = asks;
    expect(questions!.length).toBeGreaterThanOrEqual(2);
    for (const question of questions!) {
      expect(question.options.length).toBeGreaterThanOrEqual(2);
      // The runtime adds a free-text answer, so the agent lists no Other.
      expect(
        question.options.some((option) => /^other\b/i.test(option.label)),
      ).toBe(false);
    }
  });

  test("when a question suggests an answer, put that choice first and mark it recommended", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        [
          "payments-v42 is on the canary. The error rate has been flat for 30 minutes: https://sentry.example.com/organizations/acme/canary/payments-v42/",
          "Morgan posted in #proj-checkout that checkout p95 went from 210 ms to 890 ms right after payments-v42 landed: https://sentry.example.com/organizations/acme/explore/traces/checkout-p95/",
          "I have to decide whether to roll it out to every region. Ask me in the Inbox, with what you would pick.",
        ].join("\n"),
        { author: MAYA },
      ),
    );

    const asks = askedQuestions(conversation);
    expect(asks).toHaveLength(1);
    // The suggested choice comes first and says so.
    const [[question]] = asks as [[AskedQuestion]];
    expect(question.options[0]?.label).toMatch(/\(Recommended\)$/);
    expect(
      question.options.filter((option) =>
        option.label.endsWith("(Recommended)"),
      ),
    ).toHaveLength(1);
  });

  test("when a scope choice does not block the work, choose the conventional option and state it without an item", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Write a small Python function that turns a list of dicts into CSV text.",
        { author: MAYA },
      ),
    );

    // The delimiter, header, and quoting are scope choices with a
    // conventional default. They do not need the person.
    expect(toolCallsOf("askUserQuestion", conversation)).toHaveLength(0);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply contains a Python function that turns a list of dicts into CSV text.",
          "The reply states at least one choice that it made, such as the header row, the delimiter, or the quoting.",
        ],
        fail: [
          "Do not ask the user to choose an option before giving the function.",
          "Do not end with an offer or a question about extra work.",
        ],
      }),
    );
  });

  test("when an Automation run needs the creator's decision, ask it and finish the run", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      createdBy: MAYA,
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: "Wednesday is a company holiday this week. Check with me whether to cancel Wednesday's team lunch or move it to Thursday, then post the plan here.",
    });

    const delivery = await run(heartbeat());

    expect(askedQuestions(delivery)).not.toHaveLength(0);
    // The card is the answer, so the run posts nothing else.
    expect(toolCallsOf("noReply", delivery)).not.toHaveLength(0);
  });

  test("when a child agent is blocked on input that only the person has, the parent asks with askUserQuestion and not in text", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Hand this off to a child agent: write the gcloud command that deploys our billing-api service to Cloud Run in the region I picked for it last week.",
        { author: MAYA },
      ),
    );

    expect(completedToolCalls("startAgent", conversation)).toHaveLength(1);
    // Only Maya knows the region she picked, so the child reports a block.
    // Its result starts the second Turn. The parent asks in the Inbox.
    const resultTurn = conversation.turns[1];
    expect(resultTurn).toBeDefined();
    expect(askedQuestions(resultTurn!)).not.toHaveLength(0);
    for (const reply of resultTurn!.replies) {
      expect(reply.text).not.toContain("?");
    }
  });
});
