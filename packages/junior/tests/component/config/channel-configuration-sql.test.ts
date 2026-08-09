import { describe, expect, it } from "vitest";
import { createDurableChannelConfigurationService } from "@/chat/configuration/sql";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

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

describe("SQL channel configuration", () => {
  it("persists configuration independently of the legacy cache", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);

    try {
      const service = createDurableChannelConfigurationService({
        channelId: "C-durable",
        db: fixture.sql.db(),
        loadLegacy: async () => null,
      });
      await service.set({
        key: "github.repo",
        value: "getsentry/junior",
        updatedBy: "U123",
      });

      const reloaded = createDurableChannelConfigurationService({
        channelId: "C-durable",
        db: fixture.sql.db(),
        loadLegacy: async () => {
          throw new Error("legacy configuration should not be read");
        },
      });
      await expect(reloaded.resolve("github.repo")).resolves.toBe(
        "getsentry/junior",
      );
    } finally {
      await fixture.close();
    }
  });

  it("copies a live legacy record into SQL once", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);

    try {
      const service = createDurableChannelConfigurationService({
        channelId: "C-cutover",
        db: fixture.sql.db(),
        loadLegacy: async () => legacyConfiguration("getsentry/legacy"),
      });
      await expect(service.resolve("github.repo")).resolves.toBe(
        "getsentry/legacy",
      );

      const reloaded = createDurableChannelConfigurationService({
        channelId: "C-cutover",
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
});
