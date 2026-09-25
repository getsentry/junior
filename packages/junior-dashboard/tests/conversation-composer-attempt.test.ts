import { describe, expect, it } from "vitest";

import { conversationAttemptForSubmit } from "../src/client/conversations/ConversationComposer";

describe("conversationAttemptForSubmit", () => {
  it("reuses the key when the trimmed text matches the last attempt", () => {
    const current = {
      idempotencyKey: "attempt-1",
      lastSubmittedText: "Continue in Junior",
    };

    expect(conversationAttemptForSubmit(current, "Continue in Junior")).toBe(
      current,
    );
  });

  it("mints a new key when the trimmed text changes", () => {
    const current = {
      idempotencyKey: "attempt-1",
      lastSubmittedText: "Continue in Junior",
    };

    const next = conversationAttemptForSubmit(current, "Continue in Junior!");
    expect(next.lastSubmittedText).toBe("Continue in Junior!");
    expect(next.idempotencyKey).not.toBe(current.idempotencyKey);
    expect(next.idempotencyKey).toBeTruthy();
  });
});
