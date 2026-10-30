import { describe, expect, it } from "vitest";
import { systemIdentityFromSource } from "@/chat/conversations/sql/actor-identity";
import { identityForActor } from "@/chat/identities/actor";

describe("actor identity", () => {
  it("keys user actors by their platform account", () => {
    expect(
      identityForActor({
        email: "person@example.com",
        fullName: "Person",
        platform: "slack",
        teamId: "T123",
        userId: "U123456",
        userName: "person",
      }),
    ).toEqual({
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U123456",
      displayName: "Person",
      handle: "person",
      email: "person@example.com",
      emailVerified: true,
      metadata: { platform: "slack" },
    });
    expect(
      identityForActor({
        email: " Web@Example.com ",
        fullName: "Web Person",
        platform: "web",
        userId: "dashboard:abc",
      }),
    ).toEqual({
      kind: "user",
      provider: "junior",
      providerSubjectId: "web@example.com",
      email: "web@example.com",
      emailVerified: true,
      displayName: "Web Person",
      metadata: { platform: "web" },
    });
    expect(
      identityForActor({ platform: "web", userId: "dashboard:abc" }),
    ).toBeUndefined();
    expect(
      identityForActor({ platform: "local", userId: "local-cli" }),
    ).toBeUndefined();
  });

  it("keys system actors like the source fallback", () => {
    const event = identityForActor({ platform: "system", name: "event" });
    expect(event).toEqual({
      kind: "system",
      provider: "junior",
      providerSubjectId: "event",
    });
    expect(systemIdentityFromSource("event")).toEqual({
      ...event,
      displayName: "Event",
    });
  });
});
