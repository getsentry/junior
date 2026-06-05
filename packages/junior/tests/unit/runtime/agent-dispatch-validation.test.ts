import { afterEach, describe, expect, it } from "vitest";
import {
  validateDispatchOptions,
  verifyDispatchCredentialSubjectAccess,
} from "@/chat/agent-dispatch/validation";
import {
  bindSlackDirectCredentialSubject,
  createSlackDirectCredentialSubject,
} from "@/chat/credentials/subject";

const validOptions = {
  idempotencyKey: "run-1",
  destination: {
    platform: "slack" as const,
    teamId: "T123",
    channelId: "C123",
  },
  input: "Run the scheduled task.",
};

function createPluginCredentialSubject(
  input: {
    channelId?: string;
    teamId?: string;
    userId?: string;
  } = {},
) {
  process.env.JUNIOR_SECRET = "dispatch-validation-secret";
  const subject = createSlackDirectCredentialSubject({
    channelId: input.channelId ?? "D123",
    teamId: input.teamId ?? "T123",
    userId: input.userId ?? "U123",
  });
  if (!subject) {
    throw new Error("Expected test credential subject to be created");
  }
  return subject;
}

function createBoundCredentialSubject(
  input: {
    channelId?: string;
    teamId?: string;
    userId?: string;
  } = {},
) {
  const subject = createPluginCredentialSubject(input);
  const boundSubject = bindSlackDirectCredentialSubject({
    channelId: input.channelId ?? "D123",
    teamId: input.teamId ?? "T123",
    subject,
  });
  if (!boundSubject) {
    throw new Error("Expected test credential subject to be bound");
  }
  return boundSubject;
}

describe("agent dispatch validation", () => {
  afterEach(() => {
    delete process.env.JUNIOR_SECRET;
  });

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
          ...createPluginCredentialSubject(),
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
        credentialSubject: createPluginCredentialSubject(),
      }),
    ).not.toThrow();
  });

  it("rejects delegated credential subjects without real actor ids", async () => {
    expect(
      createSlackDirectCredentialSubject({
        channelId: "D123",
        teamId: "T123",
        userId: "unknown",
      }),
    ).toBeUndefined();
    process.env.JUNIOR_SECRET = "dispatch-validation-secret";

    const unboundSubject = {
      type: "user" as const,
      userId: "unknown",
      allowedWhen: "private-direct-conversation" as const,
    };

    expect(
      bindSlackDirectCredentialSubject({
        channelId: "D123",
        teamId: "T123",
        subject: unboundSubject,
      }),
    ).toBeUndefined();

    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "D123",
        },
        credentialSubject: unboundSubject,
      }),
    ).toThrow("Dispatch credentialSubject userId is required");

    await expect(
      verifyDispatchCredentialSubjectAccess({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "D123",
        },
        credentialSubject: {
          ...createBoundCredentialSubject(),
          userId: "unknown",
        },
      }),
    ).rejects.toThrow(
      "Dispatch credentialSubject must match the private direct Slack destination",
    );
  });

  it("verifies delegated credential subject bindings locally", async () => {
    await expect(
      verifyDispatchCredentialSubjectAccess({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "D123",
        },
        credentialSubject: createBoundCredentialSubject(),
      }),
    ).resolves.toBeUndefined();

    await expect(
      verifyDispatchCredentialSubjectAccess({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "D123",
        },
        credentialSubject: createBoundCredentialSubject({ channelId: "D999" }),
      }),
    ).rejects.toThrow(
      "Dispatch credentialSubject must match the private direct Slack destination",
    );

    await expect(
      verifyDispatchCredentialSubjectAccess({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "D123",
        },
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
        } as any,
      }),
    ).rejects.toThrow(
      "Dispatch credentialSubject must match the private direct Slack destination",
    );
  });
});
