import { describe, expect, it } from "vitest";
import { formatCliFailure } from "@/cli/failure";

describe("formatCliFailure", () => {
  it("includes the database error behind a failed query", () => {
    const postgres = Object.assign(
      new Error("canceling statement due to lock timeout"),
      { code: "55P03" },
    );
    const query = new Error(
      'Failed query: ALTER TABLE "junior_conversations" ADD COLUMN "x" text;\nparams: ',
      { cause: postgres },
    );

    expect(formatCliFailure(query)).toBe(
      'Failed query: ALTER TABLE "junior_conversations" ADD COLUMN "x" text;\nparams:\ncaused by: canceling statement due to lock timeout (55P03)',
    );
  });

  it("formats a thrown value that is not an Error", () => {
    expect(formatCliFailure("boom")).toBe("boom");
  });
});
