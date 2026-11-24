-- Every input of a Turn has the same Source. Drizzle cannot declare an
-- exclusion constraint, so it lives only here.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ADD CONSTRAINT "junior_turn_inbox_one_source" EXCLUDE USING gist ("turn_id" WITH =, "source" WITH <>);
