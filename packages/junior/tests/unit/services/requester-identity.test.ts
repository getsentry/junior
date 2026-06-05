import { describe, expect, it } from "vitest";
import {
  normalizeActorUserId,
  normalizeActorIdentity,
  slackActorIdentity,
} from "@/chat/services/requester-identity";

describe("requester identity", () => {
  it("normalizes actor user ids without preserving synthetic unknown", () => {
    expect(normalizeActorUserId(" U039RR91S ")).toBe("U039RR91S");
    expect(normalizeActorUserId("unknown")).toBeUndefined();
    expect(normalizeActorUserId("")).toBeUndefined();
  });

  it("does not promote Slack ids into actor display names", () => {
    expect(
      normalizeActorIdentity(
        {
          fullName: "U039RR91S",
          userId: "U039RR91S",
          userName: "U039RR91S",
        },
        "U039RR91S",
      ),
    ).toEqual({ userId: "U039RR91S" });
  });

  it("does not promote synthetic unknown display names", () => {
    expect(
      normalizeActorIdentity(
        {
          fullName: "unknown",
          userId: "U039RR91S",
          userName: "unknown",
        },
        "U039RR91S",
      ),
    ).toEqual({ userId: "U039RR91S" });
  });

  it("does not preserve synthetic unknown actor ids", () => {
    expect(
      normalizeActorIdentity(
        {
          fullName: "unknown",
          userId: "unknown",
          userName: "unknown",
        },
        "unknown",
      ),
    ).toBeUndefined();
  });

  it("builds Slack actor identity from the resolved Slack profile", () => {
    expect(
      slackActorIdentity("U039RR91S", {
        email: "david@example.com",
        fullName: "David Cramer",
        userName: "dcramer",
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "dcramer",
    });
  });

  it("drops profile fields when caller context points at a different user", () => {
    expect(
      normalizeActorIdentity(
        {
          email: "david@example.com",
          fullName: "David Cramer",
          userId: "U039RR91S",
          userName: "dcramer",
        },
        "U_OTHER",
      ),
    ).toEqual({ userId: "U_OTHER" });
  });

  it("omits unresolved Slack profile fields instead of inventing identity", () => {
    expect(slackActorIdentity("U039RR91S", null)).toEqual({
      userId: "U039RR91S",
    });
    expect(
      slackActorIdentity("U039RR91S", {
        email: "noreply",
      }),
    ).toEqual({ userId: "U039RR91S" });
  });

  it("requires a Slack user id when building Slack actor identity", () => {
    expect(() => slackActorIdentity("", null)).toThrow(
      "Slack actor identity requires a user id",
    );
  });
});
