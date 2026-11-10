import { isPostgresErrorCode } from "./postgres-error";

// DDL waits for every open transaction on its table, and later queries on the
// table wait behind it. A short wait keeps traffic moving, and a retry finds a
// gap between transactions.
const LOCK_TIMEOUT_MS = 5_000;
const ATTEMPTS = 10;
const RETRY_DELAY_MS = 2_000;

interface SessionClient {
  query(statement: string): Promise<unknown>;
  release(destroy?: boolean): void;
}

/**
 * Run Drizzle migrations on one session with a short lock wait, and retry when
 * the wait times out. Drizzle rolls back the failed migration transaction.
 */
export async function migrateWithLockTimeout<Client extends SessionClient>(
  connect: () => Promise<Client>,
  migrate: (client: Client) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const client = await connect();
    try {
      await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await migrate(client);
      return;
    } catch (error) {
      // Drizzle wraps the Postgres error in `cause`.
      const lockTimedOut =
        error instanceof Error && isPostgresErrorCode(error.cause, "55P03");
      if (!lockTimedOut || attempt === ATTEMPTS) {
        throw error;
      }
    } finally {
      // Destroy the session so its lock_timeout cannot reach pool queries.
      client.release(true);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}
