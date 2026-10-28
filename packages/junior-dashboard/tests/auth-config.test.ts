import { describe, expect, it } from "vitest";
import { dashboardSessionSchema } from "../src/api/schema";

describe("dashboard auth config", () => {
  it("requires a valid email for every dashboard session", () => {
    expect(
      dashboardSessionSchema.parse({
        user: { email: "person@example.com" },
      }),
    ).toEqual({ user: { email: "person@example.com" } });

    for (const email of [undefined, null, "not-an-email"]) {
      expect(
        dashboardSessionSchema.safeParse({ user: { email } }).success,
      ).toBe(false);
    }
  });
});
