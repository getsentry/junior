import { describe, expect, it } from "vitest";
import { validateDispatchOptions } from "@/chat/agent-dispatch/validation";

const validOptions = {
  idempotencyKey: "run-1",
  destination: {
    platform: "slack" as const,
    teamId: "T123",
    channelId: "C123",
  },
  input: "Run the scheduled task.",
};

describe("agent dispatch validation", () => {
  it("accepts a valid Slack channel dispatch", () => {
    expect(() => validateDispatchOptions(validOptions)).not.toThrow();
  });

  it("bounds durable idempotency and metadata keys", () => {
    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        idempotencyKey: "x".repeat(513),
      }),
    ).toThrow("Dispatch idempotencyKey exceeds the maximum length");

    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        metadata: {
          ["x".repeat(129)]: "value",
        },
      }),
    ).toThrow("Dispatch metadata key exceeds the maximum length");
  });

  it("requires delegated credential subjects to target direct Slack conversations", () => {
    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
        },
      }),
    ).toThrow(
      "Dispatch credentialSubject requires a private direct Slack destination",
    );

    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "D123",
        },
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
        },
      }),
    ).not.toThrow();
  });
});
