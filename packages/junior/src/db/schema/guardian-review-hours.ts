import {
  bigint,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/**
 * Guardian review counts per UTC hour and decision. The event store adds to
 * them in the transaction that appends each `guardian_action_reviewed` event,
 * so a stats read does not scan event payloads.
 */
export const juniorGuardianReviewHours = pgTable(
  "junior_guardian_review_hours",
  {
    hour: timestamptz("hour").notNull(),
    decision: text("decision").notNull(),
    reviews: integer("reviews").notNull(),
    // Null until a review of the hour and decision reports a cost.
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      name: "junior_guardian_review_hours_hour_decision_pk",
      columns: [table.hour, table.decision],
    }),
  ],
);
