import { createCachedReport } from "../cached-report";
import { readPeopleListFromSql } from "./list.query";
import { actorDirectoryReportSchema } from "../schema/person";

/**
 * Load the people list from verified user identities in SQL. Every viewer
 * gets the same list, so one cached copy serves them all.
 */
export const readPeopleList = createCachedReport({
  // Each Turn changes the list, but it reports hours and days, so a list
  // that is a few minutes old reads the same.
  freshMs: 15 * 60_000,
  // A read takes seconds. Until this ends, a request gets the last list at
  // once and starts a refresh, however long ago the last request was.
  keepMs: 7 * 24 * 60 * 60_000,
  key: "people-list",
  read: readPeopleListFromSql,
  refreshFailedEvent: "people_list.refresh.failed",
  schema: actorDirectoryReportSchema,
});
