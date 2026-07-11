import { readPeopleProfileFromSql } from "./profile.query";
import { actorProfileReportSchema } from "./schema";
import type { ActorProfileReport } from "./schema";

/** Load one person profile from verified user identities in SQL. */
export async function readPeopleProfile(
  email: string,
): Promise<ActorProfileReport> {
  return actorProfileReportSchema.parse(await readPeopleProfileFromSql(email));
}
