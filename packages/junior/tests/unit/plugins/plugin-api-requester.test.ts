import { describe, expect, it } from "vitest";
import { requesterSchema } from "@sentry/junior-plugin-api";

describe("requesterSchema", () => {
  it("requires Slack platform, team id, and user id when requester is present", () => {
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
});
