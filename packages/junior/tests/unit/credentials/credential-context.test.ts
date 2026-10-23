import { describe, expect, it } from "vitest";
import {
  credentialLogContext,
  credentialUserSubjectId,
  parseCredentialContext,
} from "@/chat/credentials/context";

describe("credential context", () => {
  const delegatedSubject = {
    type: "user" as const,
    userId: "U123",
    allowedWhen: "private-direct-conversation" as const,
    binding: {
      type: "slack-direct-conversation" as const,
      teamId: "T123",
      channelId: "D123",
      signature: "v1=test",
    },
  };
  const unboundDelegatedSubject = {
    type: "user" as const,
    userId: "U123",
    allowedWhen: "private-direct-conversation" as const,
  };

  it("resolves the user OAuth subject from the current actor or delegated subject", () => {
    expect(
      credentialUserSubjectId({
        actor: { type: "user", userId: "U123" },
      }),
    ).toBe("U123");
    expect(
      credentialUserSubjectId({
        actor: { platform: "system", name: "scheduler" },
        subject: delegatedSubject,
      }),
    ).toBe("U123");
    expect(
      credentialUserSubjectId({
        actor: { platform: "system", name: "scheduler" },
      }),
    ).toBeUndefined();
  });

  it("logs the delegated owner as the accountable user of a system run", () => {
    expect(
      credentialLogContext({ actor: { type: "user", userId: "U123" } }),
    ).toEqual({ userId: "U123", actorType: "user", actorId: "U123" });
    expect(
      credentialLogContext({
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "scheduled-automation",
          taskId: "task-1",
          binding: {
            type: "scheduled-automation",
            plugin: "scheduler",
            taskId: "task-1",
            signature: "v1=test",
          },
        },
      }),
    ).toEqual({
      userId: "U123",
      actorType: "system",
      actorId: "scheduler",
      taskId: "task-1",
      credentialAllowedWhen: "scheduled-automation",
    });
  });

  it("parses untrusted egress contexts with the same actor rules", () => {
    expect(
      parseCredentialContext({
        actor: { type: "user", userId: "U123" },
        subject: { type: "user", userId: "U999" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { platform: "system", name: "scheduler" },
        subject: delegatedSubject,
      }),
    ).toEqual({
      actor: { platform: "system", name: "scheduler" },
      subject: delegatedSubject,
    });
    expect(
      parseCredentialContext({
        actor: { platform: "system", name: "scheduler" },
        subject: unboundDelegatedSubject,
      }),
    ).toBeUndefined();
  });

  it("rejects malformed untrusted credential contexts", () => {
    expect(parseCredentialContext(undefined)).toBeUndefined();
    expect(parseCredentialContext({})).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { platform: "system", name: "unknown" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { platform: "system", name: "" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { platform: "system", name: " scheduler " },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { type: "user", userId: "" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { type: "user", userId: "unknown" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { type: "user", userId: " U123 " },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { platform: "system", name: "scheduler" },
        subject: { type: "user", userId: "U123" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { platform: "system", name: "scheduler" },
        subject: {
          ...delegatedSubject,
          userId: "unknown",
        },
      }),
    ).toBeUndefined();
  });
});
