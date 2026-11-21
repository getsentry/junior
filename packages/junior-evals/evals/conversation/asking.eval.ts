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

/** The `request` of each action item that the agent added. */
function askedRequests(conversation: { toolCalls: ToolCall[] }) {
  return completedToolCalls("addInboxItem", conversation)
    .map((call) => call.input as { kind?: string; request?: unknown })
    .filter((input) => input.kind === "action")
    .map((input) => input.request);
}

describe("Asking a Person", () => {
  test("when the work needs facts that only the person knows, ask with an inbox item", async ({
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
    expect(askedRequests(conversation)).not.toHaveLength(0);
  });

  test("when a question suggests an answer, cite the evidence for it and against it on the question", async ({
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

    const asks = completedToolCalls("addInboxItem", conversation)
      .map(
        (call) =>
          call.input as {
            kind?: string;
            request?: {
              evidence?: Array<{ url?: string | null }> | null;
              fields: Array<{ options?: Array<{ recommended?: boolean }> }>;
            };
          },
      )
      .filter((input) => input.kind === "action");
    expect(asks).toHaveLength(1);
    const [ask] = asks;
    expect(
      ask!.request?.fields.some((field) =>
        field.options?.some((option) => option.recommended),
      ),
    ).toBe(true);
    // Whichever answer it suggests, one source supports it and the other
    // argues against it, so the question cites both.
    const urls = (ask!.request?.evidence ?? []).map((entry) => entry.url ?? "");
    expect(urls.some((url) => url.includes("/canary/payments-v42"))).toBe(true);
    expect(urls.some((url) => url.includes("/checkout-p95"))).toBe(true);
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
    expect(toolCallsOf("addInboxItem", conversation)).toHaveLength(0);
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

  test("when an Automation run needs the creator's decision, add an action item and finish the run", async ({
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

    expect(askedRequests(delivery)).not.toHaveLength(0);
    // The card is the answer, so the run posts nothing else.
    expect(toolCallsOf("noReply", delivery)).not.toHaveLength(0);
  });

  test("when a child agent is blocked on input that only the person has, the parent adds an action item and does not ask in text", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Hand this off to a child agent: write the gcloud command that deploys our billing-api service to Cloud Run in the region I picked for it last week.",
        { author: MAYA },
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    // Only Maya knows the region she picked, so the child reports a block.
    // Its result starts the second Turn. The parent asks in the Inbox.
    const resultTurn = conversation.turns[1];
    expect(resultTurn).toBeDefined();
    expect(askedRequests(resultTurn!)).not.toHaveLength(0);
    for (const reply of resultTurn!.replies) {
      expect(reply.text).not.toContain("?");
    }
  });
});
