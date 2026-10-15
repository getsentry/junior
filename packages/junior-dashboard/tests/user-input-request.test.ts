import { describe, expect, it } from "vitest";
import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import { openUserInputRequest } from "../src/client/conversations/userInputRequest";

const createdAt = "2026-10-15T00:00:00.000Z";

function askEvent(
  seq: number,
  status: "completed" | "error" | "running" = "completed",
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
          input: {
            question: "Use my fix for the merge conflict?",
            options: [
              { label: "Accept", description: "Push the fix." },
              { label: "Decline" },
            ],
          },
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
    expect(openUserInputRequest([userMessage(1), askEvent(2)])).toEqual({
      toolCallId: "ask-1",
      question: "Use my fix for the merge conflict?",
      options: [
        { label: "Accept", description: "Push the fix." },
        { label: "Decline" },
      ],
    });
    expect(openUserInputRequest([askEvent(1), userMessage(2)])).toBeUndefined();
  });

  it("ignores a request that did not complete", () => {
    expect(openUserInputRequest([askEvent(1, "running")])).toBeUndefined();
    expect(
      openUserInputRequest([askEvent(1), askEvent(2, "error")]),
    ).toBeUndefined();
  });
});
