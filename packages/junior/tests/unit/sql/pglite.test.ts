import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";

let fixture: LocalPgliteFixture<unknown> | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("PGlite migration lock", () => {
  it("preserves writes when a migration callback fails", async () => {
    fixture = await createLocalPgliteFixture<unknown>({});
    await fixture.execute(`
CREATE TABLE migration_progress (
  cursor INTEGER NOT NULL
)
`);

    await expect(
      fixture.withMigrationLock("test-journal", async () => {
        await fixture!.execute(
          "INSERT INTO migration_progress (cursor) VALUES ($1)",
          [1],
        );
        throw new Error("migration interrupted");
      }),
    ).rejects.toThrow("migration interrupted");

    await expect(
      fixture.query("SELECT cursor FROM migration_progress"),
    ).resolves.toEqual([{ cursor: 1 }]);
  });
});
