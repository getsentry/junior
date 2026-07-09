import { describe, expect, it, vi } from "vitest";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
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
    query: vi.fn(),
    transaction: vi.fn(async (callback) => await callback()),
    withLock: vi.fn(async (_lockName, callback) => await callback()),
  };
}

vi.mock("@/db/neon", () => ({
  createNeonJuniorSqlExecutor: vi.fn(() => EXECUTORS.neon),
}));

vi.mock("@/db/postgres", () => ({
  createPostgresJuniorSqlExecutor: vi.fn(() => EXECUTORS.postgres),
}));

describe("createJuniorSqlExecutor", () => {
  it("uses node-postgres for the postgres driver", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:junior@localhost:5432/junior",
        driver: "postgres",
      }),
    ).toBe(EXECUTORS.postgres);
  });

  it("uses Neon for the neon driver", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:junior@example.test/junior",
        driver: "neon",
      }),
    ).toBe(EXECUTORS.neon);
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
