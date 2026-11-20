import { createCachedReport } from "../cached-report";
import { readPeopleListFromSql } from "./list.query";
import { actorDirectoryReportSchema } from "../schema/person";

/**
 * Load the people list from verified user identities in SQL. Every viewer
 * gets the same list, so one cached copy serves them all.
 */
export const readPeopleList = createCachedReport({
  key: "people-list",
  read: readPeopleListFromSql,
  refreshFailedEvent: "people_list.refresh.failed",
  schema: actorDirectoryReportSchema,
});
