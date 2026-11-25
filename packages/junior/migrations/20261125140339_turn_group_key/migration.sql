-- The host now groups inputs into Turns with a key that core only compares.
-- Inputs written before this change get the key that the host builds for
-- them: the Actor Identity and the Source kind. The next migration makes the
-- column required.
ALTER TABLE "junior_turn_inbox" ADD COLUMN "group_key" text;--> statement-breakpoint
-- junior:bounded-backfill: no Source sends inputs to core yet, so only local core CLI runs wrote rows
UPDATE "junior_turn_inbox" SET "group_key" = "actor_identity_id" || ':' || ("source"->>'kind');--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_group_key_not_null" CHECK ("group_key" IS NOT NULL) NOT VALID;--> statement-breakpoint
-- Every input of a Turn has the same group key. Drizzle cannot declare an
-- exclusion constraint, so it lives only here.
ALTER TABLE "junior_turn_inbox" DROP CONSTRAINT "junior_turn_inbox_one_source";--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_one_group" EXCLUDE USING gist ("turn_id" WITH =, "group_key" WITH <>);--> statement-breakpoint
ALTER TABLE "junior_turns" DROP CONSTRAINT "junior_turns_actor_identity_id_junior_identities_id_fkey";--> statement-breakpoint
ALTER TABLE "junior_turns" DROP COLUMN "actor_identity_id";
