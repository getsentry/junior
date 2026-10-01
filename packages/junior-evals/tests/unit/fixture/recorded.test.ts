import { describe, expect, it } from "vitest";
import { sanitizeRecordedEvents } from "../../../src/fixture/recorded";

function row(type: string, payload: Record<string, unknown>) {
  return {
    createdAtMs: 0,
    historyVersion: 0,
    idempotencyKey: null,
    payload,
    schemaVersion: 1,
    seq: 0,
    type,
  };
}

describe("sanitizeRecordedEvents", () => {
  it("replaces people and workspace ids but keeps tool and Junior names", () => {
    const [message, toolCall] = sanitizeRecordedEvents([
      row("message", {
        authorIdentityId: "identity-1",
        meta: {
          author: {
            email: "Dana@Acme.com",
            fullName: "Dana Smith",
            userId: "U0123ABCD",
          },
        },
        text: "Ping dana@acme.com in T0123ABCD about the TRACKING launch on THURSDAY, status UNKNOWN.",
      }),
      row("assistant_message", {
        message: JSON.stringify({
          content: [{ type: "toolCall", name: "updatePlan" }],
          meta: { author: { isBot: true, userName: "junior" } },
          text: "- user_name: dana\n",
        }),
      }),
      row("authorization_requested", { provider: "github" }),
    ]);

    expect(message?.payload).toEqual({
      meta: {
        author: {
          email: "person1@example.com",
          fullName: "Person 1",
          userId: "U0PERSON1",
        },
      },
      text: "Ping person1@example.com in TEVAL about the TRACKING launch on THURSDAY, status UNKNOWN.",
    });
    expect(JSON.parse(String(toolCall?.payload.message))).toEqual({
      content: [{ type: "toolCall", name: "updatePlan" }],
      meta: { author: { isBot: true, userName: "junior" } },
      text: "- user_name: Person 2\n",
    });
  });
});
