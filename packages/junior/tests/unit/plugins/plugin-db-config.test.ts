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

function dbPlugin(required: boolean) {
  return defineJuniorPlugin({
    database: { required },
    manifest: {
      name: required ? "required-db" : "optional-db",
      displayName: required ? "Required DB" : "Optional DB",
      description: "Plugin database config test",
    },
  });
}

afterEach(() => {
  restoreDatabaseEnv();
  vi.resetModules();
});

describe("plugin database config", () => {
  it("fails required database plugins when no SQL URL is configured", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.JUNIOR_DATABASE_URL;
    const { validatePluginDatabaseRequirements } = await loadValidator();

    expect(() => validatePluginDatabaseRequirements([dbPlugin(true)])).toThrow(
      "Plugin database access requires JUNIOR_DATABASE_URL or DATABASE_URL for: required-db",
    );
  });

  it("allows optional database plugins without a SQL URL", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.JUNIOR_DATABASE_URL;
    const { validatePluginDatabaseRequirements } = await loadValidator();

    expect(() =>
      validatePluginDatabaseRequirements([dbPlugin(false)]),
    ).not.toThrow();
  });

  it("allows required database plugins when a SQL URL is configured", async () => {
    delete process.env.DATABASE_URL;
    process.env.JUNIOR_DATABASE_URL = "postgres://user:pass@example.test/neon";
    const { validatePluginDatabaseRequirements } = await loadValidator();

    expect(() =>
      validatePluginDatabaseRequirements([dbPlugin(true)]),
    ).not.toThrow();
  });
});
