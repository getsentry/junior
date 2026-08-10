import { describe, expect, it } from "vitest";
import { scoreSlackNameQuery } from "@/chat/slack/users";

describe("scoreSlackNameQuery", () => {
  it("prefers a full-member first-name token over an external display-name prefix", () => {
    const member = scoreSlackNameQuery(
      {
        name: "colin.kawai",
        real_name: "Colin Kawai",
        profile: { display_name: "Colin Kawai", real_name: "Colin Kawai" },
      },
      "colin",
    );
    const external = scoreSlackNameQuery(
      {
        name: "colin.curtin",
        real_name: "Colin Curtin",
        is_stranger: true,
        profile: {
          display_name: "Colin Curtin (Square)",
          real_name: "Colin Curtin",
        },
      },
      "colin",
    );

    expect(member).toBeGreaterThan(external);
    expect(member).toBe(85);
    expect(external).toBe(45);
  });

  it("scores multi-token full names above single first-name hits", () => {
    const fullName = scoreSlackNameQuery(
      {
        name: "colin.kawai",
        real_name: "Colin Kawai",
        profile: { display_name: "Colin Kawai", real_name: "Colin Kawai" },
      },
      "colin kawai",
    );
    const firstNameOnly = scoreSlackNameQuery(
      {
        name: "colin.curtin",
        real_name: "Colin Curtin",
        profile: {
          display_name: "Colin Curtin (Square)",
          real_name: "Colin Curtin",
        },
      },
      "colin kawai",
    );

    expect(fullName).toBe(100);
    expect(firstNameOnly).toBe(0);
    expect(fullName).toBeGreaterThan(firstNameOnly);
  });

  it("keeps exact handle matches above token matches", () => {
    expect(
      scoreSlackNameQuery(
        {
          name: "markus",
          real_name: "Markus Unterwaditzer",
          profile: { display_name: "Markus", real_name: "Markus Unterwaditzer" },
        },
        "markus",
      ),
    ).toBe(100);
  });
});
