-- The host now groups inputs into Turns with a key that core only compares.
-- Inputs written before this change get the key that the host builds for
-- them: the Actor Identity and the Source kind.
ALTER TABLE "junior_turn_inbox" ADD COLUMN "group_key" text;--> statement-breakpoint
UPDATE "junior_turn_inbox" SET "group_key" = "actor_identity_id" || ':' || ("source"->>'kind');--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ALTER COLUMN "group_key" SET NOT NULL;--> statement-breakpoint
-- Every input of a Turn has the same group key. Drizzle cannot declare an
-- exclusion constraint, so it lives only here.
ALTER TABLE "junior_turn_inbox" DROP CONSTRAINT "junior_turn_inbox_one_source";--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_one_group" EXCLUDE USING gist ("turn_id" WITH =, "group_key" WITH <>);--> statement-breakpoint
ALTER TABLE "junior_turns" DROP CONSTRAINT "junior_turns_actor_identity_id_junior_identities_id_fkey";--> statement-breakpoint
ALTER TABLE "junior_turns" DROP COLUMN "actor_identity_id";
