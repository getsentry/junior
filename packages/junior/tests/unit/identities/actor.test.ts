import { describe, expect, it } from "vitest";
import { toStoredSlackActor, type SlackActor } from "@/chat/actor";
import { systemIdentityFromSource } from "@/chat/conversations/sql/actor-identity";
import {
  identityForActor,
  identityForStoredActor,
} from "@/chat/identities/actor";

describe("actor identity", () => {
  it("gives runtime and stored actors the same identity key", () => {
    const slack: SlackActor = {
      email: "person@example.com",
      fullName: "Person",
      platform: "slack",
      teamId: "T123",
      userId: "U123456",
      userName: "person",
    };
    const slackIdentity = {
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U123456",
      displayName: "Person",
      handle: "person",
      email: "person@example.com",
      emailVerified: true,
      metadata: { platform: "slack" },
    };
    expect(identityForActor(slack)).toEqual(slackIdentity);
    expect(identityForStoredActor(toStoredSlackActor(slack))).toEqual(
      slackIdentity,
    );

    const webIdentity = {
      kind: "user",
      provider: "junior",
      providerSubjectId: "web@example.com",
      email: "web@example.com",
      emailVerified: true,
      displayName: "Web Person",
      metadata: { platform: "web" },
    };
    expect(
      identityForActor({
        email: " Web@Example.com ",
        fullName: "Web Person",
        platform: "web",
        userId: "dashboard:abc",
      }),
    ).toEqual(webIdentity);
    expect(
      identityForStoredActor({
        email: "web@example.com",
        fullName: "Web Person",
      }),
    ).toEqual(webIdentity);
    expect(
      identityForActor({ platform: "web", userId: "dashboard:abc" }),
    ).toBeUndefined();
  });

  it("keeps local users apart from system identities", () => {
    expect(
      identityForActor({
        fullName: "Local CLI",
        platform: "local",
        userId: "local-cli",
        userName: "local",
      }),
    ).toEqual({
      kind: "user",
      provider: "local",
      providerSubjectId: "local-cli",
      displayName: "Local CLI",
      handle: "local",
      metadata: { platform: "local" },
    });

    const event = identityForActor({ platform: "system", name: "event" });
    expect(event).toEqual({
      kind: "system",
      provider: "junior",
      providerSubjectId: "event",
    });
    expect(systemIdentityFromSource("event")).toMatchObject(event!);
  });
});
