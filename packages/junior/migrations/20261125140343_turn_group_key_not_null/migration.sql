-- The validated check lets SET NOT NULL skip its table scan.
ALTER TABLE "junior_turn_inbox" VALIDATE CONSTRAINT "junior_turn_inbox_group_key_not_null";--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" ALTER COLUMN "group_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_turn_inbox" DROP CONSTRAINT "junior_turn_inbox_group_key_not_null";
