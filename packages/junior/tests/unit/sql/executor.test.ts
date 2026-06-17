import { describe, expect, it, vi } from "vitest";
import type { JuniorSqlExecutor } from "@/chat/sql/db";
import { createJuniorSqlExecutor } from "@/chat/sql/executor";
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

vi.mock("@/chat/sql/neon", () => ({
  createNeonJuniorSqlExecutor: vi.fn(() => EXECUTORS.neon),
}));

vi.mock("@/chat/sql/postgres", () => ({
  createPostgresJuniorSqlExecutor: vi.fn(() => EXECUTORS.postgres),
}));

describe("createJuniorSqlExecutor", () => {
  it("uses node-postgres for localhost URLs", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:junior@localhost:5432/junior",
      }),
    ).toBe(EXECUTORS.postgres);
  });

  it("uses Neon for remote PostgreSQL URLs", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:junior@example.test/junior",
      }),
    ).toBe(EXECUTORS.neon);
  });

  it("passes non-URL connection strings to node-postgres", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "host=localhost dbname=junior user=junior",
      }),
    ).toBe(EXECUTORS.postgres);
  });

  it("passes URL-parser rejected connection strings to node-postgres", () => {
    expect(
      createJuniorSqlExecutor({
        connectionString: "postgres://junior:pa#ss@localhost:5432/junior",
      }),
    ).toBe(EXECUTORS.postgres);
  });
});
