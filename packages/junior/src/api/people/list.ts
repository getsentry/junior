import { readPeopleListFromSql } from "./list.query";
import { actorDirectoryReportSchema } from "./schema";
import type { ActorDirectoryReport } from "./schema";
import type { ApiRoute } from "../route";

/** Load the people list from verified user identities in SQL. */
export async function readPeopleList(): Promise<ActorDirectoryReport> {
  return actorDirectoryReportSchema.parse(await readPeopleListFromSql());
}

/** Serve the People directory endpoint. */
export default {
  method: "get",
  path: "/",
  handler: async () => Response.json(await readPeopleList()),
} satisfies ApiRoute;
