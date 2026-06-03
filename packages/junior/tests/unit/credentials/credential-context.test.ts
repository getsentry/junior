import { describe, expect, it } from "vitest";
import {
  credentialUserSubjectId,
  parseCredentialContext,
} from "@/chat/credentials/context";

describe("credential context", () => {
  const delegatedSubject = {
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
        actor: { type: "system", id: "scheduler" },
        subject: delegatedSubject,
      }),
    ).toBe("U123");
    expect(
      credentialUserSubjectId({
        actor: { type: "system", id: "scheduler" },
      }),
    ).toBeUndefined();
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
        actor: { type: "system", id: "scheduler" },
        subject: delegatedSubject,
      }),
    ).toEqual({
      actor: { type: "system", id: "scheduler" },
      subject: delegatedSubject,
    });
  });

  it("rejects malformed untrusted credential contexts", () => {
    expect(parseCredentialContext(undefined)).toBeUndefined();
    expect(parseCredentialContext({})).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { type: "system", id: "" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { type: "user", userId: "" },
      }),
    ).toBeUndefined();
    expect(
      parseCredentialContext({
        actor: { type: "system", id: "scheduler" },
        subject: { type: "user", userId: "U123" },
      }),
    ).toBeUndefined();
  });
});
