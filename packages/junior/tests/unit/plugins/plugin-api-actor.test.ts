import { describe, expect, it } from "vitest";
import { actorSchema } from "@sentry/junior-plugin-api";

describe("actorSchema", () => {
  it("requires Slack team id for Slack actors", () => {
    expect(
      actorSchema.safeParse({
        platform: "slack",
        teamId: "T123",
        userId: "U123",
      }).success,
    ).toBe(true);

    expect(actorSchema.safeParse({ userId: "U123" }).success).toBe(false);
    expect(
      actorSchema.safeParse({
        platform: "slack",
        userId: "U123",
      }).success,
    ).toBe(false);
  });

  it("accepts local actors without Slack team state", () => {
    expect(
      actorSchema.safeParse({
        platform: "local",
        userId: "local-cli",
        userName: "local",
      }).success,
    ).toBe(true);

    expect(
      actorSchema.safeParse({
        platform: "local",
        teamId: "T123",
        userId: "local-cli",
      }).success,
    ).toBe(false);
  });

  it("accepts explicit system actors", () => {
    expect(
      actorSchema.safeParse({
        platform: "system",
        name: "scheduler",
      }).success,
    ).toBe(true);

    expect(
      actorSchema.safeParse({
        platform: "system",
        name: "unknown",
      }).success,
    ).toBe(false);
    expect(
      actorSchema.safeParse({
        type: "system",
        id: "scheduler",
      }).success,
    ).toBe(false);
  });
});
