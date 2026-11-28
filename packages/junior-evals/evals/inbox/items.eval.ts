import { describe, expect } from "vitest";
import {
  heartbeat,
  reply,
  inboxItemAnswer,
  inboxItemDismiss,
  slackMention,
  webMessage,
  type InboxItem,
} from "@junior-evals/fixture/inputs";
import {
  insertInboxItem,
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import {
  completedToolCalls,
  toolCallsOf,
  toolOutput,
} from "@junior-evals/fixture/results";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
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

// An earlier run asked about the pull request and linked it.
const ENTRY_REQUEST = {
  ...DECISION_REQUEST,
  related: [{ label: "Acme entry", url: PULL_REQUEST_URL }],
};

function ownerItem(bug: string): InboxItem {
  return {
    body: `The ${bug} bug has no owner.`,
    request: {
      question: `Who should own the ${bug} bug?`,
      fields: [{ id: "owner", kind: "text", label: "Owner" }],
    },
    title: `Owner for the ${bug} bug`,
  };
}

function itemOutput(call: Parameters<typeof toolOutput>[0]) {
  return toolOutput(call) as {
    item: { id: string; status: string };
  };
}

describe("Inbox", () => {
  test("when a later run gets the open question of an earlier run, change it instead of asking again", async ({
    run,
  }) => {
    const destination = slackChannel();
    const automation = await insertScheduledAutomation({
      credentialMode: "system",
      destination,
      due: true,
      task: ENTRY_REVIEW_TASK,
    });
    const existing = await insertInboxItem({
      automationId: automation.id,
      body: "Acme uses BUSL with a six-year change date.",
      destination,
      kind: "action",
      request: ENTRY_REQUEST,
      subject: { id: "ask:acme-entry", kind: "question" },
      title: "Review the Acme entry",
    });

    const delivery = await run(heartbeat());

    // The run's task lists the open question by its id, so the run changes
    // that item, or leaves it, and asks no second question.
    expect(completedToolCalls("askUserQuestion", delivery)).toEqual([]);
    for (const call of completedToolCalls("updateInboxItem", delivery)) {
      expect(itemOutput(call).item.id).toBe(existing.id);
    }
  });

  test("when a person says the pull request merged, close its open item with a reason", async ({
    run,
  }) => {
    const destination = slackChannel();
    const existing = await insertInboxItem({
      body: "Acme uses BUSL with a six-year change date.",
      destination,
      kind: "action",
      request: ENTRY_REQUEST,
      subject: { id: "ask:acme-entry", kind: "question" },
      title: "Review the Acme entry",
    });

    const reply = await run(
      slackMention(
        `${PULL_REQUEST_URL} got merged, so nobody needs to review the Acme entry anymore. Clean it up in the Inbox.`,
        { channel: destination },
      ),
    );

    const closes = completedToolCalls("updateInboxItem", reply).filter(
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

  test("when one Turn batches two answers and a typed message after a dismiss, act on each answer for its own item, answer the typed message as its own request, and leave the dismissed work alone", async ({
    run,
  }) => {
    const conversation = await run(
      [
        inboxItemAnswer(ownerItem("login"), { owner: ["Priya"] }),
        inboxItemAnswer(ownerItem("billing"), { owner: ["Sam"] }),
        inboxItemDismiss({
          body: "Twelve branches are older than 90 days.",
          title: "Delete the stale staging branches",
        }),
        webMessage("Also, what is 17 times 23?"),
      ],
      {
        history: [
          webMessage(
            "The login bug and the billing bug need owners, and the stale staging branches need a cleanup. Ask me in the Inbox. When I answer, write one assignment message per bug that I can paste into the tracker.",
          ),
          reply(
            "I added three items to the Inbox: an owner for the login bug, an owner for the billing bug, and the staging branch cleanup. I'll write the assignment messages when you answer.",
          ),
        ],
      },
    );

    // The answers and the typed message arrive before the Turn starts, so
    // one Turn handles them all, and the agent does not ask again. The
    // dismiss is not a decision, so the agent never sees it.
    expect(conversation.turns).toHaveLength(1);
    expect(toolCallsOf("askUserQuestion", conversation)).toEqual([]);
    expect(conversation.replies.map((entry) => entry.text).join("\n")).toMatch(
      /391/,
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply has an assignment message that gives the login bug to Priya.",
          "The reply has an assignment message that gives the billing bug to Sam.",
          "The reply answers 17 times 23 as its own request, with 391.",
        ],
        fail: [
          "Do not give the login bug to Sam or the billing bug to Priya.",
          "Do not say that the stale staging branches were deleted or will be deleted.",
          "Do not ask the person again who owns either bug.",
        ],
      }),
    );
  });
});
