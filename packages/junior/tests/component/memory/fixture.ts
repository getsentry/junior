import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { MemoryDb } from "@/chat/memory/store";

export interface MemoryFixture {
  db(): MemoryDb;
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  close(): Promise<void>;
}

/** Connect to this worker's migrated Junior database. */
export async function createMemoryFixture(): Promise<MemoryFixture> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("Memory tests need the Junior Postgres test harness.");
  }
  const pool = new pg.Pool({ connectionString });
  const db = drizzle({ client: pool });
  return {
    db: () => db,
    execute: async (statement, params = []) => {
      await pool.query(statement, [...params]);
    },
    close: () => pool.end(),
  };
}
