import { describe, expect, it } from "vitest";
import { createDurableLocationConfigurationService } from "@/chat/configuration/sql";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const DESTINATION = {
  platform: "slack" as const,
  teamId: "T-durable",
  channelId: "C-durable",
};

function legacyConfiguration(value: string) {
  return {
    configuration: {
      schemaVersion: 1,
      entries: {
        "github.repo": {
          key: "github.repo",
          value,
          scope: "conversation",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
      },
    },
  };
}

describe("SQL location configuration", () => {
  it("persists configuration independently of the legacy cache", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);

    try {
      const service = createDurableLocationConfigurationService({
        destination: DESTINATION,
        db: fixture.sql.db(),
        loadLegacy: async () => null,
      });
      await service.set({
        key: "github.repo",
        value: "getsentry/junior",
        updatedBy: "U123",
      });

      const reloaded = createDurableLocationConfigurationService({
        destination: DESTINATION,
        db: fixture.sql.db(),
        loadLegacy: async () => {
          throw new Error("legacy configuration should not be read");
        },
      });
      await expect(reloaded.resolve("github.repo")).resolves.toBe(
        "getsentry/junior",
      );
      await expect(reloaded.get("github.repo")).resolves.toMatchObject({
        scope: "location",
      });
    } finally {
      await fixture.close();
    }
  });

  it("copies a live legacy record into SQL once", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);

    try {
      const service = createDurableLocationConfigurationService({
        destination: {
          platform: "slack",
          teamId: "T-cutover",
          channelId: "C-cutover",
        },
        db: fixture.sql.db(),
        loadLegacy: async () => legacyConfiguration("getsentry/legacy"),
      });
      await expect(service.resolve("github.repo")).resolves.toBe(
        "getsentry/legacy",
      );

      const reloaded = createDurableLocationConfigurationService({
        destination: {
          platform: "slack",
          teamId: "T-cutover",
          channelId: "C-cutover",
        },
        db: fixture.sql.db(),
        loadLegacy: async () => null,
      });
      await expect(reloaded.resolve("github.repo")).resolves.toBe(
        "getsentry/legacy",
      );
    } finally {
      await fixture.close();
    }
  });

  it("keeps a concurrent SQL write over a stale legacy cutover", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const destination = {
      platform: "slack" as const,
      teamId: "T-race",
      channelId: "C-race",
    };

    try {
      const writer = createDurableLocationConfigurationService({
        destination,
        db: fixture.sql.db(),
        loadLegacy: async () => null,
      });
      const reader = createDurableLocationConfigurationService({
        destination,
        db: fixture.sql.db(),
        loadLegacy: async () => {
          await writer.set({
            key: "github.repo",
            value: "getsentry/fresh",
            updatedBy: "U-fresh",
          });
          return legacyConfiguration("getsentry/stale");
        },
      });

      await expect(reader.resolve("github.repo")).resolves.toBe(
        "getsentry/fresh",
      );
      await expect(writer.resolve("github.repo")).resolves.toBe(
        "getsentry/fresh",
      );
    } finally {
      await fixture.close();
    }
  });
});
