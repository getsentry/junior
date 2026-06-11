import { describe, expect, it } from "vitest";
import { requesterSchema } from "@sentry/junior-plugin-api";

describe("requesterSchema", () => {
  it("requires Slack team id for Slack requesters", () => {
    expect(
      requesterSchema.safeParse({
        platform: "slack",
        teamId: "T123",
        userId: "U123",
      }).success,
    ).toBe(true);

    expect(requesterSchema.safeParse({ userId: "U123" }).success).toBe(false);
    expect(
      requesterSchema.safeParse({
        platform: "slack",
        userId: "U123",
      }).success,
    ).toBe(false);
  });

  it("accepts local requesters without Slack team state", () => {
    expect(
      requesterSchema.safeParse({
        platform: "local",
        userId: "local-cli",
        userName: "local",
      }).success,
    ).toBe(true);

    expect(
      requesterSchema.safeParse({
        platform: "local",
        teamId: "T123",
        userId: "local-cli",
      }).success,
    ).toBe(false);
  });
});
