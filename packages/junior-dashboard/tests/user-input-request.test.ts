import { describe, expect, it } from "vitest";
import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import { openUserInputRequest } from "../src/client/conversations/userInputRequest";

const createdAt = "2026-10-15T00:00:00.000Z";

const INPUT = {
  question: "Use my fix for the merge conflict?",
  options: [
    { label: "Accept", description: "Push the fix." },
    { label: "Decline" },
  ],
};

// Reporting splits one call: the assistant event has the input, and the
// later result event has the status without the input.
function askCall(seq: number): ConversationReportEvent {
  return {
    createdAt,
    seq,
    data: {
      type: "tool_calls",
      calls: [
        {
          toolCallId: "ask-1",
          name: "requestUserInput",
          status: "running",
          input: INPUT,
        },
      ],
    },
  };
}

function askResult(
  seq: number,
  status: "completed" | "error" = "completed",
): ConversationReportEvent {
  return {
    createdAt,
    seq,
    data: {
      type: "tool_calls",
      calls: [
        {
          toolCallId: "ask-1",
          name: "requestUserInput",
          status,
          output: { status: "waiting_for_answer" },
        },
      ],
    },
  };
}

function userMessage(seq: number): ConversationReportEvent {
  return {
    createdAt,
    seq,
    data: {
      type: "message",
      messageId: `message-${seq}`,
      role: "user",
      text: "Accept",
    },
  };
}

describe("openUserInputRequest", () => {
  it("returns the question until a later user message answers it", () => {
    expect(
      openUserInputRequest([userMessage(1), askCall(2), askResult(3)]),
    ).toEqual({ toolCallId: "ask-1", ...INPUT });
    expect(
      openUserInputRequest([askCall(1), askResult(2), userMessage(3)]),
    ).toBeUndefined();
    // A repeated result must not reopen an answered request.
    expect(
      openUserInputRequest([
        askCall(1),
        askResult(2),
        userMessage(3),
        askResult(4),
      ]),
    ).toBeUndefined();
  });

  it("ignores a request that did not complete", () => {
    expect(openUserInputRequest([askCall(1)])).toBeUndefined();
    expect(
      openUserInputRequest([askCall(1), askResult(2, "error")]),
    ).toBeUndefined();
  });
});
