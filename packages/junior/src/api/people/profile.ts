import { readPeopleProfileFromSql } from "./profile.query";
import type { ActorProfileReport } from "./types";

/** Load one person profile from verified user identities in SQL. */
export async function readPeopleProfile(
  email: string,
): Promise<ActorProfileReport> {
  return readPeopleProfileFromSql(email);
}

export type {
  ConversationStatsItem,
  ConversationSummaryReport,
  PeopleConversationStatus,
  PeopleConversationSurface,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
  ActorTotalsReport,
} from "./types";
