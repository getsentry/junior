import { describe, expect, it } from "vitest";
import {
  createRequester,
  createRequesterFromStoredSlackRequester,
  createSlackRequester,
  isActorUserId,
  parseActorUserId,
  parseStoredSlackRequester,
  toStoredSlackRequester,
} from "@/chat/requester";

describe("requester", () => {
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
      createRequester(
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
      createRequester(
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
      createRequester(
        {
          fullName: "David Cramer",
          userId: "unknown",
          userName: "dcramer",
        },
        "unknown",
      ),
    ).toBeUndefined();
  });

  it("builds Slack requester from the resolved Slack profile", () => {
    expect(
      createSlackRequester("U039RR91S", {
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
      createRequester(
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
    expect(createSlackRequester("U039RR91S", null)).toEqual({
      userId: "U039RR91S",
    });
    expect(
      createSlackRequester("U039RR91S", {
        email: "noreply",
      }),
    ).toEqual({ userId: "U039RR91S" });
  });

  it("requires a Slack user id when building Slack requester", () => {
    expect(() => createSlackRequester("", null)).toThrow(
      "Slack requester requires a user id",
    );
  });

  it("uses stored Slack requester fields only for the same actor id", () => {
    expect(
      createRequesterFromStoredSlackRequester({
        userId: "U039RR91S",
        requester: {
          email: "david@example.com",
          fullName: "David Cramer",
          slackUserId: "U039RR91S",
          slackUserName: "dcramer",
        },
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "dcramer",
    });

    expect(() =>
      createRequesterFromStoredSlackRequester({
        userId: "U039RR91S",
        requester: { slackUserId: "U_OTHER" },
      }),
    ).toThrow("Stored Slack requester must match actor user id");
    expect(() =>
      createRequesterFromStoredSlackRequester({
        userId: "U039RR91S",
        requester: { slackUserId: " U039RR91S " },
      }),
    ).toThrow("Stored Slack requester requires a user id");
  });

  it("parses canonical serialized Slack requesters without repair", () => {
    expect(
      parseStoredSlackRequester({
        email: "david@example.com",
        fullName: "David Cramer",
        slackUserId: "U039RR91S",
        slackUserName: "dcramer",
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      slackUserId: "U039RR91S",
      slackUserName: "dcramer",
    });
    expect(
      parseStoredSlackRequester({
        slackUserId: " U039RR91S ",
      }),
    ).toBeUndefined();
  });

  it("converts runtime requesters to durable Slack requester state", () => {
    expect(
      toStoredSlackRequester({
        email: "david@example.com",
        fullName: "David Cramer",
        userId: "U039RR91S",
        userName: "dcramer",
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      slackUserId: "U039RR91S",
      slackUserName: "dcramer",
    });
  });
});
