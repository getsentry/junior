/**
 * Integration tests for repairSlackDestinationVisibility.
 *
 * Uses PGlite (or a real Postgres fixture when DATABASE_URL points at
 * localhost) to verify that the migration correctly restores public
 * visibility for confirmed-public channels and leaves everything else alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// config.ts runs readChatConfig() at the module level, which requires
// DATABASE_URL. Set a placeholder here (before any module imports execute)
// so the config module initialises without throwing. Tests inject their own
// SQL executor so this value is never actually used for connections.
vi.hoisted(() => {
  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  };
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgres://localhost:5432/junior_test";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  return original;
});

import { repairSlackDestinationVisibility } from "@/cli/upgrade/migrations/slack-destination-visibility-repair";
import { juniorDestinations } from "@/chat/conversations/sql/schema";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  // Keep SLACK_BOT_TOKEN set between cases; restored in the final afterEach.
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
});

type InfoResult = { kind: "public" | "private" | "skipped" };

/** Build a stub Slack info function that routes by channel ID. */
function makeStubInfoFn(
  channelMap: Record<string, InfoResult["kind"]>,
): (channelId: string) => Promise<InfoResult> {
  return async (channelId) => ({ kind: channelMap[channelId] ?? "skipped" });
}

const MOCK_CONTEXT = {
  io: { info: () => {} },
  stateAdapter: null as never,
};

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("repairSlackDestinationVisibility", () => {
  it("restores public visibility for confirmed public channels and leaves private ones alone", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    await store.migrate();

    try {
      const db = fixture.sql.db();

      await db.insert(juniorDestinations).values([
        {
          id: "dest-public",
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C111",
          kind: "channel",
          visibility: "private",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "dest-private",
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C222",
          kind: "channel",
          visibility: "private",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      const result = await repairSlackDestinationVisibility(MOCK_CONTEXT, {
        executor: fixture.sql,
        slackInfoFn: makeStubInfoFn({ C111: "public", C222: "private" }),
      });

      expect(result.scanned).toBe(2);
      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(0);
      // C111 should be public now
      const [publicRow] = await db
        .select({ visibility: juniorDestinations.visibility })
        .from(juniorDestinations)
        .where(eq(juniorDestinations.id, "dest-public"));
      expect(publicRow?.visibility).toBe("public");
      // C222 stays private
      const [privateRow] = await db
        .select({ visibility: juniorDestinations.visibility })
        .from(juniorDestinations)
        .where(eq(juniorDestinations.id, "dest-private"));
      expect(privateRow?.visibility).toBe("private");
    } finally {
      await fixture.close();
    }
  });

  it("skips inaccessible channels without changing their visibility", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    await store.migrate();

    try {
      const db = fixture.sql.db();

      await db.insert(juniorDestinations).values([
        {
          id: "dest-inaccessible",
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C333",
          kind: "channel",
          visibility: "private",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      const result = await repairSlackDestinationVisibility(MOCK_CONTEXT, {
        executor: fixture.sql,
        slackInfoFn: async () => {
          throw new Error("not_in_channel");
        },
      });

      expect(result.scanned).toBe(1);
      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(1);

      const [row] = await db
        .select({ visibility: juniorDestinations.visibility })
        .from(juniorDestinations)
        .where(eq(juniorDestinations.id, "dest-inaccessible"));
      expect(row?.visibility).toBe("private");
    } finally {
      await fixture.close();
    }
  });

  it("does not query already-public channel destinations", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    await store.migrate();

    try {
      const db = fixture.sql.db();
      const infoFn = vi.fn(makeStubInfoFn({}));

      await db.insert(juniorDestinations).values([
        {
          id: "dest-already-public",
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C444",
          kind: "channel",
          visibility: "public",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      const result = await repairSlackDestinationVisibility(MOCK_CONTEXT, {
        executor: fixture.sql,
        slackInfoFn: infoFn,
      });

      expect(result.scanned).toBe(0);
      expect(result.migrated).toBe(0);
      expect(infoFn).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("does not touch dm or group kind destinations", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    await store.migrate();

    try {
      const db = fixture.sql.db();
      const infoFn = vi.fn(makeStubInfoFn({}));

      await db.insert(juniorDestinations).values([
        {
          id: "dest-dm",
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "D555",
          kind: "dm",
          visibility: "private",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "dest-group",
          provider: "slack",
          providerTenantId: "T123",
          providerDestinationId: "C666",
          kind: "group",
          visibility: "private",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      const result = await repairSlackDestinationVisibility(MOCK_CONTEXT, {
        executor: fixture.sql,
        slackInfoFn: infoFn,
      });

      expect(result.scanned).toBe(0);
      expect(result.migrated).toBe(0);
      expect(infoFn).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("returns zero counts and skips API calls when no Slack token is configured", async () => {
    restoreEnv("SLACK_BOT_TOKEN", undefined);

    const fixture = await createLocalJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    await store.migrate();

    try {
      const infoFn = vi.fn(makeStubInfoFn({}));

      const result = await repairSlackDestinationVisibility(MOCK_CONTEXT, {
        executor: fixture.sql,
        slackInfoFn: infoFn,
      });

      expect(result.scanned).toBe(0);
      expect(infoFn).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});
