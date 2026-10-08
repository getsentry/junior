import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import { vi } from "vitest";
import * as googleSqlSchema from "../src/db/schema";
import type { GoogleDb } from "../src/store";

export const ACCOUNT_EMAIL = "junior@example.com";
export const ADMIN_EMAIL = "admin@example.com";
export const CLIENT_ID = "client-id.apps.googleusercontent.com";

/** Configure the plugin through the same env vars a deployment uses. */
export function stubGoogleEnv(): void {
  vi.stubEnv("GOOGLE_WORKSPACE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_WORKSPACE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GOOGLE_WORKSPACE_ACCOUNT_EMAIL", ACCOUNT_EMAIL);
  vi.stubEnv("GOOGLE_WORKSPACE_ADMIN_EMAILS", ADMIN_EMAIL);
  vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
}

/** Create an in-memory database with the packaged migrations applied. */
export async function createGoogleDb(): Promise<LocalPgliteFixture<GoogleDb>> {
  const fixture = await createLocalPgliteFixture<GoogleDb>(googleSqlSchema);
  const dir = resolve(__dirname, "../migrations");
  for (const file of (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await fixture.execute(await readFile(resolve(dir, file), "utf8"));
  }
  return fixture;
}

/** Build an unsigned identity token with the given claims. */
export function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

export const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.owned";
