import { describe, expect, it } from "vitest";
import {
  buildActorIdentity,
  isActorUserId,
  parseActorUserId,
  slackActorIdentity,
} from "@/chat/services/requester-identity";

describe("requester identity", () => {
  it("parses exact actor user ids without accepting synthetic values", () => {
    expect(parseActorUserId("U039RR91S")).toBe("U039RR91S");
    expect(parseActorUserId(" U039RR91S ")).toBeUndefined();
    expect(parseActorUserId("unknown")).toBeUndefined();
    expect(parseActorUserId("")).toBeUndefined();
    expect(isActorUserId("U039RR91S")).toBe(true);
    expect(isActorUserId(" U039RR91S ")).toBe(false);
  });

  it("does not promote Slack ids into actor display names", () => {
    expect(
      buildActorIdentity(
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
      buildActorIdentity(
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
      buildActorIdentity(
        {
          fullName: "David Cramer",
          userId: "unknown",
          userName: "dcramer",
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
      buildActorIdentity(
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
