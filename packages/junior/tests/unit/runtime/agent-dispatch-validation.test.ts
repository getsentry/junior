import { afterEach, describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  validateDispatchOptions,
  verifyDispatchCredentialSubjectAccess,
} from "@/chat/agent-dispatch/validation";
import { parseDispatchRecord } from "@/chat/agent-dispatch/store";
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
  source: createSlackSource({
    teamId: "T123",
    channelId: "C123",

    type: "priv",
  }),
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

  it("rejects malformed dispatch destination payloads", () => {
    expect(() => validateDispatchOptions(undefined)).toThrow(
      "Dispatch options are required",
    );
    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        destination: undefined as unknown as typeof validOptions.destination,
      }),
    ).toThrow("Dispatch destination platform must be slack");
    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        unexpected: "field",
      }),
    ).toThrow("Dispatch options must not include unknown fields");

    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          threadTs: "1700000000.000",
        },
      }),
    ).toThrow("Dispatch destination must not include unknown fields");
    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "slack:C123:1700000000.000",
        },
      }),
    ).toThrow("Dispatch destination channelId must be a Slack channel id");
  });

  it("rejects malformed dispatch source payloads", () => {
    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        source: {
          ...validOptions.source,
          threadTs: "1700000000.000",
          unexpected: "field",
        },
      }),
    ).toThrow("Dispatch source must not include unknown fields");

    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        source: {
          ...validOptions.source,
          teamId: "not-a-team",
        },
      }),
    ).toThrow("Dispatch source teamId must be a Slack team id");
  });

  it("rejects multiline dispatch metadata", () => {
    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        metadata: {
          schedule: "Every day\n- dispatch.actor.name: attacker",
        },
      }),
    ).toThrow("Dispatch metadata values must be single-line strings");

    expect(() =>
      validateDispatchOptions({
        ...validOptions,
        metadata: {
          ["schedule\nattacker"]: "Every day",
        },
      }),
    ).toThrow("Dispatch metadata keys must be single-line strings");
  });

  it("rejects non-canonical dispatch records from durable state", () => {
    const baseRecord = {
      actor: { platform: "system", name: "scheduler" },
      attempt: 0,
      createdAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      destination: validOptions.destination,
      id: "dispatch_123",
      idempotencyKey: "run-1",
      input: "Run the scheduled task.",
      maxAttempts: 5,
      plugin: "scheduler",
      source: validOptions.source,
      status: "pending",
      updatedAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      version: 1,
    };

    expect(
      parseDispatchRecord({
        ...baseRecord,
        destination: {
          ...validOptions.destination,
          threadTs: "1700000000.000",
        },
      }),
    ).toBeUndefined();

    expect(
      parseDispatchRecord({
        ...baseRecord,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D999",
            signature: "v1=test",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("rejects persisted dispatch records without source", () => {
    const legacyRecord = {
      actor: { platform: "system", name: "scheduler" },
      attempt: 0,
      createdAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      destination: validOptions.destination,
      id: "dispatch_legacy",
      idempotencyKey: "run-legacy",
      input: "Run the scheduled task.",
      maxAttempts: 5,
      plugin: "scheduler",
      status: "pending",
      updatedAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      version: 1,
    };

    expect(parseDispatchRecord(legacyRecord)).toBeUndefined();
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
        metadata: null as unknown as Record<string, string>,
      }),
    ).toThrow("Dispatch metadata values must be strings");

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
        credentialSubject: null,
      }),
    ).toThrow("Dispatch credentialSubject type must be user");

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

    const unboundRuntimeSubject = {
      type: "user",
      userId: "U123",
      allowedWhen: "private-direct-conversation",
    } as unknown as NonNullable<
      Parameters<
        typeof verifyDispatchCredentialSubjectAccess
      >[0]["credentialSubject"]
    >;

    await expect(
      verifyDispatchCredentialSubjectAccess({
        ...validOptions,
        destination: {
          ...validOptions.destination,
          channelId: "D123",
        },
        credentialSubject: unboundRuntimeSubject,
      }),
    ).rejects.toThrow(
      "Dispatch credentialSubject must match the private direct Slack destination",
    );
  });
});
