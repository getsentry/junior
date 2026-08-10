import type { User } from "@sentry/junior-plugin-api";
import { readPeopleProfileFromSql } from "./profile.query";
import { actorProfileReportSchema } from "../schema/person";
import type { ActorProfileReport } from "../schema/person";

/** Load one person profile from verified user identities in SQL. */
export async function readPeopleProfile(
  email: string,
  options: { viewer?: User } = {},
): Promise<ActorProfileReport> {
  return actorProfileReportSchema.parse(
    await readPeopleProfileFromSql(email, options),
  );
}
