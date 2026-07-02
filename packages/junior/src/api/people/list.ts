import { readPeopleListFromSql } from "./list.query";
import type { RequesterDirectoryReport } from "./types";

/** Load the people list from verified user identities in SQL. */
export async function readPeopleList(): Promise<RequesterDirectoryReport> {
  return readPeopleListFromSql();
}

export type {
  RequesterDirectoryReport,
  RequesterIdentity,
  RequesterSummaryReport,
  RequesterTotalsReport,
} from "./types";
