import { describe, expect, test, vi } from "vitest";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { createLocalJuniorSqlFixture } from "../../../fixtures/sql";
import { seedPeople } from "./fixture";

describe("people list API", () => {
  test("lists people by shared verified actor identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedPeople(fixture);

      const report = await readPeopleListFromSql({
        db: fixture.sql.db(),
      });

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
        active: 0,
        activeDays: 2,
        conversations: 2,
        failed: 1,
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
