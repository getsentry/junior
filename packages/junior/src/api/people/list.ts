import { readPeopleListFromSql } from "./list.query";
import { actorDirectoryReportSchema } from "./schema";
import type { ActorDirectoryReport } from "./schema";

/** Load the people list from verified user identities in SQL. */
export async function readPeopleList(): Promise<ActorDirectoryReport> {
  return actorDirectoryReportSchema.parse(await readPeopleListFromSql());
}
