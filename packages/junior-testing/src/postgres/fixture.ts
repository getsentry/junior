import pg from "pg";
import { getPostgresTestDatabaseUrl } from "./worker";

export interface PostgresTestFixture<TDatabase> {
  db(): TDatabase;
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connect to the migrated database of the current Vitest worker. `connect`
 * builds the package's database client, such as a Drizzle instance, on the
 * fixture pool. The shared setup file empties the tables before each test.
 */
export async function createPostgresTestFixture<TDatabase>(
  connect: (pool: pg.Pool) => TDatabase,
): Promise<PostgresTestFixture<TDatabase>> {
  const pool = new pg.Pool({
    connectionString: await getPostgresTestDatabaseUrl(),
  });
  const db = connect(pool);
  return {
    db: () => db,
    execute: async (statement, params = []) => {
      await pool.query(statement, [...params]);
    },
    close: () => pool.end(),
  };
}
