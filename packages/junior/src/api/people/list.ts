import { readPeopleListFromSql } from "./list.query";
import type { ActorDirectoryReport } from "./types";

/** Load the people list from verified user identities in SQL. */
export async function readPeopleList(): Promise<ActorDirectoryReport> {
  return readPeopleListFromSql();
}

export type {
  ActorDirectoryReport,
  ActorIdentity,
  ActorSummaryReport,
  ActorTotalsReport,
} from "./types";
