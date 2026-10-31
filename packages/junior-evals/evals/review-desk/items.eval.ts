import { describe, expect } from "vitest";
import { heartbeat, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertReviewItem,
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const PULL_REQUEST_URL = "https://github.com/fairsource/fair.io/pull/812";

const ENTRY_REVIEW_TASK = [
  `Pull request ${PULL_REQUEST_URL} adds the company entry for Acme to the Fair Source list.`,
  "Its license check is unclear: Acme uses BUSL with a six-year change date.",
  "I need to decide if we approve or reject the entry, and why.",
  "Get that decision from me. Do not comment on or merge the pull request.",
].join(" ");

const DECISION_REQUEST = {
  question: "Approve or reject the Acme entry?",
  fields: [
    {
      id: "decision",
      kind: "choice" as const,
      label: "Decision",
      options: [{ label: "Approve" }, { label: "Reject" }],
    },
    { id: "reason", kind: "text" as const, label: "Reason" },
  ],
};

function itemOutput(call: Parameters<typeof toolOutput>[0]) {
  return toolOutput(call) as {
    created?: boolean;
    item: { id: string; status: string };
  };
}

describe("Review desk", () => {
  test("when an Automation run needs a person's decision, add an action item and do not wait for it", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      task: ENTRY_REVIEW_TASK,
    });

    const delivery = await run(heartbeat());

    const added = completedToolCalls("addReviewItem", delivery);
    expect(added).toHaveLength(1);
    expect(added[0]!.input).toMatchObject({
      kind: "action",
      request: expect.objectContaining({ fields: expect.any(Array) }),
    });
    expect(itemOutput(added[0]!)).toMatchObject({
      created: true,
      item: { status: "open" },
    });
    // The answer arrives later as a message, so the run does not ask in
    // the thread and ends without a block.
    expect(toolCallsOf("requestUserInput", delivery)).toEqual([]);
    expect(
      completedToolCalls("finishAutomationRun", delivery).map(toolOutput),
    ).not.toContainEqual(expect.objectContaining({ result: "misconfigured" }));
  });

  test("when a later run finds the open item for the same pull request, update it instead of adding another", async ({
    run,
  }) => {
    const destination = slackChannel();
    const automation = await insertScheduledAutomation({
      credentialMode: "system",
      destination,
      due: true,
      task: ENTRY_REVIEW_TASK,
    });
    const existing = await insertReviewItem({
      automationId: automation.id,
      body: "Acme uses BUSL with a six-year change date.",
      dedupeKey: "fair-source:acme-entry",
      destination,
      kind: "action",
      request: DECISION_REQUEST,
      subject: { id: PULL_REQUEST_URL, url: PULL_REQUEST_URL },
      title: "Review the Acme entry",
    });

    const delivery = await run(heartbeat());

    // The run works with the review desk. Each completed add updates the
    // open item, so no second item starts.
    expect(
      toolCallsOf("addReviewItem", delivery).length +
        toolCallsOf("searchReviewItems", delivery).length,
    ).toBeGreaterThan(0);
    const added = completedToolCalls("addReviewItem", delivery).map(itemOutput);
    expect(added.filter((output) => output.created)).toEqual([]);
    for (const output of added) {
      expect(output.item.id).toBe(existing.id);
    }
  });

  test("when a person says the pull request merged, close its open item with a reason", async ({
    run,
  }) => {
    const destination = slackChannel();
    const existing = await insertReviewItem({
      body: "Acme uses BUSL with a six-year change date.",
      dedupeKey: "fair-source:acme-entry",
      destination,
      kind: "action",
      request: DECISION_REQUEST,
      subject: { id: PULL_REQUEST_URL, url: PULL_REQUEST_URL },
      title: "Review the Acme entry",
    });

    const reply = await run(
      slackMention(
        `${PULL_REQUEST_URL} got merged, so nobody needs to review the Acme entry anymore. Clean it up on the review desk.`,
        { channel: destination },
      ),
    );

    const closes = completedToolCalls("updateReviewItem", reply).filter(
      (call) => (call.input as { status?: string }).status,
    );
    expect(closes).toHaveLength(1);
    expect(closes[0]!.input).toMatchObject({
      id: existing.id,
      reason: expect.any(String),
      status: expect.stringMatching(/^(done|dismissed)$/),
    });
    expect(itemOutput(closes[0]!).item.status).toMatch(/^(done|dismissed)$/);
  });
});
