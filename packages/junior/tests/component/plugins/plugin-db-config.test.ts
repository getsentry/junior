import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_JUNIOR_DATABASE_URL = process.env.JUNIOR_DATABASE_URL;

function restoreDatabaseEnv(): void {
  if (ORIGINAL_DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
  if (ORIGINAL_JUNIOR_DATABASE_URL === undefined) {
    delete process.env.JUNIOR_DATABASE_URL;
  } else {
    process.env.JUNIOR_DATABASE_URL = ORIGINAL_JUNIOR_DATABASE_URL;
  }
}

async function loadValidator() {
  vi.resetModules();
  return await import("@/chat/plugins/db");
}

function dbPlugin() {
  return defineJuniorPlugin({
    database: {},
    manifest: {
      name: "database-plugin",
      displayName: "Database Plugin",
      description: "Plugin database config test",
    },
  });
}

function statelessPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "stateless-plugin",
      displayName: "Stateless Plugin",
      description: "Plugin database config test",
    },
  });
}

afterEach(() => {
  restoreDatabaseEnv();
  vi.resetModules();
});

describe("plugin database config", () => {
  it("fails database plugins when no SQL URL is configured", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.JUNIOR_DATABASE_URL;
    const { validatePluginDatabaseRequirements } = await loadValidator();

    expect(() => validatePluginDatabaseRequirements([dbPlugin()])).toThrow(
      "Plugin database access requires JUNIOR_DATABASE_URL or DATABASE_URL for: database-plugin",
    );
  });

  it("allows plugins without database declarations when no SQL URL is configured", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.JUNIOR_DATABASE_URL;
    const { validatePluginDatabaseRequirements } = await loadValidator();

    expect(() =>
      validatePluginDatabaseRequirements([statelessPlugin()]),
    ).not.toThrow();
  });

  it("allows required database plugins when a SQL URL is configured", async () => {
    delete process.env.DATABASE_URL;
    process.env.JUNIOR_DATABASE_URL = "postgres://user:pass@example.test/neon";
    const { validatePluginDatabaseRequirements } = await loadValidator();

    expect(() =>
      validatePluginDatabaseRequirements([dbPlugin()]),
    ).not.toThrow();
  });
});
