import { describe, expect, test, vi } from "vitest";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { seedPeople } from "./fixture";

describe("people list API", () => {
  test("lists people by shared verified actor identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      await seedPeople(fixture);

      const report = await readPeopleListFromSql();

      expect(report.people.map((person) => person.actor.email)).toEqual([
        "bob@example.com",
        "alice@example.com",
        "later@example.com",
      ]);
      expect(
        report.people.find(
          (person) => person.actor.email === "alice@example.com",
        ),
      ).toMatchObject({
        active: 1,
        activeDays: 2,
        conversations: 2,
        durationMs: 1_500,
        failed: 1,
        tokens: 150,
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
        },
      });
      expect(
        report.people.some(
          (person) => person.actor.email === "untrusted@example.com",
        ),
      ).toBe(false);
      expect(report.source).toBe("conversation_index");
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
