import { type Actor, type Identity } from "@sentry/junior-plugin-api";
import type { MemoryDb } from "./store";

/** Read every identity linked to the verified web Actor. */
export async function readLinkedIdentities(
  db: MemoryDb,
  actor: Actor | undefined,
): Promise<Identity[] | undefined> {
  if (actor?.platform !== "web" || !actor.email) return undefined;
  const { findUserByEmailFromSql } = await import("@sentry/junior/api");
  return (await findUserByEmailFromSql(db as never, actor.email))?.identities;
}
