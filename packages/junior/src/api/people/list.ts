import { readPeopleListFromSql } from "./list.query";
import { actorDirectoryReportSchema } from "../schema/person";
import type { ActorDirectoryReport } from "../schema/person";
import { defineApiRoute } from "../route";

/** Load the people list from verified user identities in SQL. */
export async function readPeopleList(): Promise<ActorDirectoryReport> {
  return actorDirectoryReportSchema.parse(await readPeopleListFromSql());
}

/** Serve the People directory endpoint. */
export default defineApiRoute({
  method: "get",
  path: "/",
  responseSchema: actorDirectoryReportSchema,
  handler: readPeopleList,
});
