import {
  createPostgresTestFixture,
  type PostgresTestFixture,
} from "@sentry/junior-testing/postgres/fixture";
import { drizzle } from "drizzle-orm/node-postgres";
import { vi } from "vitest";
import * as googleSqlSchema from "../src/db/schema";
import type { GoogleDb } from "../src/store";

export const ACCOUNT_EMAIL = "junior@example.com";
/** A Junior admin who connects the account. */
export const ADMIN_EMAIL = "admin@example.com";
export const CLIENT_ID = "client-id.apps.googleusercontent.com";

/** Configure the plugin through the same env vars a deployment uses. */
export function stubGoogleEnv(): void {
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GOOGLE_WORKSPACE_ACCOUNT_EMAIL", ACCOUNT_EMAIL);
  vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
}

/** Connect to this worker's migrated Google plugin database. */
export async function createGoogleDb(): Promise<PostgresTestFixture<GoogleDb>> {
  return await createPostgresTestFixture((pool) =>
    drizzle(pool, { schema: googleSqlSchema }),
  );
}

/** Build an unsigned identity token with the given claims. */
export function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

/** Every API scope the tools need, as Google lists them in a grant. */
export const API_SCOPES =
  "https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";
