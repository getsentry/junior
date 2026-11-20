import { describeEval } from "vitest-evals";
import { reviewItemReplyEvals } from "../../src/review-item-reply-harness";

function shipItem(version: string) {
  return {
    id: `ship-${version}`,
    title: `Ship release ${version}`,
    body: "The release checks passed.",
    request: {
      question: `Ship release ${version}?`,
      fields: [
        {
          id: "decision",
          kind: "choice" as const,
          label: "Decision",
          options: [{ label: "Ship it" }, { label: "Hold" }],
        },
      ],
    },
  };
}

const ENTRY_REVIEW = {
  id: "acme-entry",
  title: "Review the Acme entry",
  body: "Acme uses BUSL with a six-year change date.",
  request: {
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
  },
};

const ROTATION_START = {
  id: "rotation-start",
  title: "Start date for the new on-call rotation",
  body: "The new rotation adds two people.",
  request: {
    question: "Which day should the new on-call rotation start?",
    fields: [{ id: "date", kind: "text" as const, label: "Start date" }],
  },
};

describeEval("Review Item Reply Matching", reviewItemReplyEvals, (it) => {
  it("when the reply picks an option, it answers the question", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5")],
      reply: "ship it",
      expected: ["ship-1.2.5"],
    });
  });

  it("when the reply only acknowledges, it answers no question", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5")],
      reply: "on it, I'll look after lunch",
      expected: [],
    });
  });

  it("when the reply asks a follow-up, it answers no question", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5")],
      reply: "what failed in the last run?",
      expected: [],
    });
  });

  it("when the reply names one of two similar questions, it answers only that one", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5"), shipItem("1.2.6")],
      reply: "Ship 1.2.6",
      expected: ["ship-1.2.6"],
    });
  });

  it("when the reply decides two questions, it answers both", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5"), shipItem("1.2.6")],
      reply: "Ship 1.2.6, hold 1.2.5 until the flaky test is fixed",
      expected: ["ship-1.2.5", "ship-1.2.6"],
    });
  });

  it("when the reply decides the later of two topics, it answers only that one", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5"), ENTRY_REVIEW],
      reply:
        "Reject the Acme entry, BUSL with that change date isn't fair source",
      expected: ["acme-entry"],
    });
  });

  it("when the reply gives the requested value, it answers the text question", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5"), ROTATION_START],
      reply: "Start it Monday the 9th",
      expected: ["rotation-start"],
    });
  });

  it("when the reply is about something else, it answers no question", async ({
    run,
  }) => {
    await run({
      items: [shipItem("1.2.5"), ENTRY_REVIEW],
      reply: "btw the build on main is red again",
      expected: [],
    });
  });
});
