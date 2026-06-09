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
          platform: "slack",
          teamId: "T123",
          userId: "U039RR91S",
          userName: "U039RR91S",
        },
        { teamId: "T123", userId: "U039RR91S" },
      ),
    ).toEqual({ platform: "slack", teamId: "T123", userId: "U039RR91S" });
  });

  it("does not promote synthetic unknown display names", () => {
    expect(
      createRequester(
        {
          fullName: "unknown",
          platform: "slack",
          teamId: "T123",
          userId: "U039RR91S",
          userName: "unknown",
        },
        { teamId: "T123", userId: "U039RR91S" },
      ),
    ).toEqual({ platform: "slack", teamId: "T123", userId: "U039RR91S" });
  });

  it("does not preserve synthetic unknown actor ids", () => {
    expect(
      createRequester(
        {
          fullName: "David Cramer",
          platform: "slack",
          teamId: "T123",
          userId: "unknown",
          userName: "dcramer",
        },
        { teamId: "T123", userId: "unknown" },
      ),
    ).toBeUndefined();
  });

  it("builds Slack requester from the resolved Slack profile", () => {
    expect(
      createSlackRequester("T123", "U039RR91S", {
        email: "david@example.com",
        fullName: "David Cramer",
        userName: "dcramer",
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      platform: "slack",
      teamId: "T123",
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
          platform: "slack",
          teamId: "T123",
          userId: "U039RR91S",
          userName: "dcramer",
        },
        { teamId: "T123", userId: "U_OTHER" },
      ),
    ).toEqual({ platform: "slack", teamId: "T123", userId: "U_OTHER" });
  });

  it("omits unresolved Slack profile fields instead of inventing identity", () => {
    expect(createSlackRequester("T123", "U039RR91S", null)).toEqual({
      platform: "slack",
      teamId: "T123",
      userId: "U039RR91S",
    });
    expect(
      createSlackRequester("T123", "U039RR91S", {
        email: "noreply",
      }),
    ).toEqual({ platform: "slack", teamId: "T123", userId: "U039RR91S" });
  });

  it("requires Slack team and user ids when building Slack requester", () => {
    expect(() => createSlackRequester("T123", "", null)).toThrow(
      "Slack requester requires team and user ids",
    );
    expect(() => createSlackRequester("", "U039RR91S", null)).toThrow(
      "Slack requester requires team and user ids",
    );
  });

  it("uses stored Slack requester fields only for the same Slack actor", () => {
    expect(
      createRequesterFromStoredSlackRequester({
        teamId: "T123",
        userId: "U039RR91S",
        requester: {
          email: "david@example.com",
          fullName: "David Cramer",
          platform: "slack",
          slackUserId: "U039RR91S",
          slackUserName: "dcramer",
          teamId: "T123",
        },
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      platform: "slack",
      teamId: "T123",
      userId: "U039RR91S",
      userName: "dcramer",
    });

    expect(() =>
      createRequesterFromStoredSlackRequester({
        teamId: "T123",
        userId: "U039RR91S",
        requester: {
          platform: "slack",
          slackUserId: "U_OTHER",
          teamId: "T123",
        },
      }),
    ).toThrow("Stored Slack requester must match actor user id");
    expect(() =>
      createRequesterFromStoredSlackRequester({
        teamId: "T123",
        userId: "U039RR91S",
        requester: {
          platform: "slack",
          slackUserId: " U039RR91S ",
          teamId: "T123",
        },
      }),
    ).toThrow("Stored Slack requester requires a user id");
    expect(() =>
      createRequesterFromStoredSlackRequester({
        teamId: "T123",
        userId: "U039RR91S",
        requester: {
          platform: "slack",
          slackUserId: "U039RR91S",
          teamId: "T999",
        },
      }),
    ).toThrow("Stored Slack requester must match actor team id");
  });

  it("preserves legacy stored Slack requester profile fields without stored team id", () => {
    expect(
      createRequesterFromStoredSlackRequester({
        teamId: "T123",
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
      platform: "slack",
      teamId: "T123",
      userId: "U039RR91S",
      userName: "dcramer",
    });
  });

  it("parses canonical serialized Slack requesters without repair", () => {
    expect(
      parseStoredSlackRequester({
        email: "david@example.com",
        fullName: "David Cramer",
        platform: "slack",
        slackUserId: "U039RR91S",
        slackUserName: "dcramer",
        teamId: "T123",
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      platform: "slack",
      slackUserId: "U039RR91S",
      slackUserName: "dcramer",
      teamId: "T123",
    });
    expect(
      parseStoredSlackRequester({
        slackUserId: " U039RR91S ",
      }),
    ).toBeUndefined();
    expect(
      parseStoredSlackRequester({
        platform: "slack",
        slackUserId: "U039RR91S",
      }),
    ).toBeUndefined();
  });

  it("converts runtime requesters to durable Slack requester state", () => {
    expect(
      toStoredSlackRequester({
        email: "david@example.com",
        fullName: "David Cramer",
        platform: "slack",
        teamId: "T123",
        userId: "U039RR91S",
        userName: "dcramer",
      }),
    ).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      platform: "slack",
      slackUserId: "U039RR91S",
      slackUserName: "dcramer",
      teamId: "T123",
    });
  });
});
