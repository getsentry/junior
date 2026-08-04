import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JuniorSqlExecutor } from "@/db/db";
import {
  createJuniorSqlExecutor,
  DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
} from "@/db/executor";
import { createNeonJuniorSqlExecutor } from "@/db/neon";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
const EXECUTORS = vi.hoisted(() => ({
  neon: executor("neon"),
  postgres: executor("postgres"),
}));

function executor(name: string): JuniorSqlExecutor {
  return {
    close: vi.fn(),
    db: vi.fn(() => {
      throw new Error(`${name} test executor does not expose Drizzle`);
    }),
    execute: vi.fn(),
    migrate: vi.fn(),
    query: vi.fn(),
    transaction: vi.fn(async (callback) => await callback()),
    withLock: vi.fn(async (_lockName, callback) => await callback()),
    withMigrationLock: vi.fn(async (_migrationTable, callback) => callback()),
  };
}

vi.mock("@/db/neon", () => ({
  createNeonJuniorSqlExecutor: vi.fn(() => EXECUTORS.neon),
}));

vi.mock("@/db/postgres", () => ({
  createPostgresJuniorSqlExecutor: vi.fn(() => EXECUTORS.postgres),
}));

describe("createJuniorSqlExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses node-postgres for the postgres driver", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:junior@localhost:5432/junior",
        driver: "postgres",
      }),
    ).toBe(EXECUTORS.postgres);
    expect(createPostgresJuniorSqlExecutor).toHaveBeenCalledWith({
      connectionString: "postgres://junior:junior@localhost:5432/junior",
      statementTimeoutMs: DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
    });
  });

  it("uses Neon for the neon driver", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:junior@example.test/junior",
        driver: "neon",
      }),
    ).toBe(EXECUTORS.neon);
    expect(createNeonJuniorSqlExecutor).toHaveBeenCalledWith({
      connectionString: "postgres://junior:junior@example.test/junior",
      statementTimeoutMs: DEFAULT_SQL_STATEMENT_TIMEOUT_MS,
    });
  });

  it("allows migration executors to disable the runtime timeout", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:junior@example.test/junior",
        driver: "neon",
        statementTimeoutMs: false,
      }),
    ).toBe(EXECUTORS.neon);
    expect(createNeonJuniorSqlExecutor).toHaveBeenCalledWith({
      connectionString: "postgres://junior:junior@example.test/junior",
      statementTimeoutMs: false,
    });
  });

  it("passes non-URL connection strings to the configured driver", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "host=localhost dbname=junior user=junior",
        driver: "postgres",
      }),
    ).toBe(EXECUTORS.postgres);
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:pa#ss@localhost:5432/junior",
        driver: "neon",
      }),
    ).toBe(EXECUTORS.neon);
  });
});
