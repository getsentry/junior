import { describe, expect, it } from "vitest";
import { readMigrationDatabaseUrl } from "@/cli/upgrade/database-url";

const POOLED =
  "postgresql://user:p%40ss@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("readMigrationDatabaseUrl", () => {
  it("uses the direct Neon endpoint for a pooled URL", () => {
    expect(
      readMigrationDatabaseUrl({
        databaseUrl: POOLED,
        driver: "neon",
        env: {},
      }),
    ).toBe(
      "postgresql://user:p%40ss@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    );
  });

  it("prefers DATABASE_URL_UNPOOLED for Neon", () => {
    expect(
      readMigrationDatabaseUrl({
        databaseUrl: POOLED,
        driver: "neon",
        env: { DATABASE_URL_UNPOOLED: " postgresql://direct.example/db " },
      }),
    ).toBe("postgresql://direct.example/db");
  });

  it("keeps other URLs", () => {
    const direct =
      "postgresql://user:pass@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb";
    const otherPooler = "postgresql://user:pass@db-pooler.example.com/app";
    for (const databaseUrl of [direct, otherPooler]) {
      expect(
        readMigrationDatabaseUrl({ databaseUrl, driver: "neon", env: {} }),
      ).toBe(databaseUrl);
    }
    expect(
      readMigrationDatabaseUrl({
        databaseUrl: "postgres://junior:junior@localhost:54322/junior",
        driver: "postgres",
        env: { DATABASE_URL_UNPOOLED: "postgresql://direct.example/db" },
      }),
    ).toBe("postgres://junior:junior@localhost:54322/junior");
  });
});
