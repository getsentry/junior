import { readPeopleProfileFromSql } from "./profile.query";
import type { RequesterProfileReport } from "./types";

/** Load one person profile from verified user identities in SQL. */
export async function readPeopleProfile(
  email: string,
): Promise<RequesterProfileReport> {
  return readPeopleProfileFromSql(email);
}

export type {
  ConversationStatsItem,
  ConversationSummaryReport,
  PeopleConversationStatus,
  PeopleConversationSurface,
  RequesterActivityDayReport,
  RequesterIdentity,
  RequesterProfileReport,
  RequesterTotalsReport,
} from "./types";
